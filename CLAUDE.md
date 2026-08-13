# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension (`src/manifest.json`) that captures full-page or
viewport screenshots two ways — scroll-and-stitch (default) or Chrome
DevTools Protocol — and downloads or copies the result. Plain HTML/CSS/JS,
no bundler, no dependencies, no test suite.

## Commands

```sh
make          # = make zip: validate manifest, stage src/ into
              # dist/chrome-fullpage-screenshot/, zip it
make build    # stage the unpacked extension into dist/ without zipping
make lint     # validate manifest.json is valid JSON — the only automated check
make clean    # remove dist/
```

Requires `make`, `python3` (stdlib only), and `zip`. There is no build step
beyond staging/zipping and no test suite — verification is manual: `make
build`, load `dist/chrome-fullpage-screenshot` (or `src/` directly) via
`chrome://extensions` → Developer mode → Load unpacked, then exercise it
against a real page. After editing `src/`, click the refresh icon on the
extension's card in `chrome://extensions` to pick up changes (no rebuild
needed if loaded straight from `src/`).

## Architecture

**`src/background.js`** (MV3 service worker) owns both capture methods and
all the capture logic — attach/capture/detach, or the whole
scroll-and-stitch loop. **`src/popup.js`** collects the three radio choices
(scope/method/output), validates the active tab, and sends one message —
`{ type: 'capture', tabId, scope, method }` via `chrome.runtime.sendMessage`
— to trigger the capture. Only the capture step itself runs in the
background worker, never the popup, because MV3 popups are torn down the
instant they lose focus; if the capture ran in the popup's own JS context,
closing the popup mid-capture would abort it uncleanly (a `chrome.debugger`
session stuck attached to the tab, or the page left scrolled wherever the
loop happened to be). Once the background worker's response comes back
with the base64 PNG, `popup.js` itself turns that into the requested
output — `chrome.downloads.download` or `navigator.clipboard.write()` — a
deliberate exception to "capture logic lives in the background worker":
`navigator.clipboard.write()` only works inside a user-gesture handler,
which only the popup's own click handler provides, so that step can't be
moved to the background worker. (It does mean closing the popup while a
download or clipboard write is still in flight can abort that step —  a
smaller-blast-radius version of the same popup-lifetime problem, since by
that point the capture itself has already finished successfully.)

Two independent capture paths, dispatched by `method`:

- **`captureWithCdp`** — `Page.getLayoutMetrics` + `Page.captureScreenshot`
  with `captureBeyondViewport`/`clip`, the same calls DevTools' own
  "Capture full size screenshot" uses. Nothing scrolls, so nested scroll
  containers and fixed/sticky elements render correctly, but scroll-gated
  content (lazy-load, virtualization) never fires.
- **`captureWithScrollStitch`** (default) — scrolls the real page in
  viewport-height steps via `chrome.scripting.executeScript`, captures each
  step with `chrome.tabs.captureVisibleTab`, stitches with
  `OffscreenCanvas`. Before the main loop, `detectFixedBands` nudges the
  page to two nearby (already-scrolled) positions and diffs the two
  screenshots row-by-row and column-by-column: a row/column that stays
  identical despite a real scroll can only be `position:
  fixed`/`sticky` content — a header/footer (full-width row match) or a
  sidebar (full-height column match). Matching tolerates a small amount of
  per-row/column noise (live badges, carets, anti-aliasing jitter) rather
  than demanding byte-exact equality, since real fixed elements are rarely
  perfectly static. Detected headers/footers shrink the scroll step and get
  drawn once from the tile where they belong; detected sidebars are drawn
  once from the first tile and left as a plain gap elsewhere (there's no
  scroll trick that reveals what, if anything, is behind a sidebar the way
  there is for a header). See the README's "Choosing a capture method" and
  "Limitations" sections for the full trade-offs and known gaps (inner
  scroll containers on SPA-style pages, corner-anchored widgets that don't
  span a full edge).

**Permissions** (`src/manifest.json`): `debugger` is only exercised by the
CDP path; `scripting` only by scroll-and-stitch. Both are scoped by
`activeTab` — no `<all_urls>`/host permissions, so the extension has no
standing access to any page. `downloads` is only needed for the "Download
PNG" output option; "Copy to clipboard" uses `navigator.clipboard.write()`
directly from the popup's click handler as a user gesture, no extra
permission needed.

## Debugging

- `background.js`'s `console.log`/`console.error` do **not** show up in the
  page's DevTools — it's a service worker, not page script. See its output
  (or set breakpoints in it) via `chrome://extensions` → this extension's
  card → **service worker** link, which opens a DevTools window attached to
  the background context. If that link reads "inactive," click it anyway;
  it wakes the worker.
- The "\<extension\> started debugging this browser" banner is expected
  and harmless for the CDP method — it's a hardcoded Chrome behavior for
  any use of `chrome.debugger`, gone as soon as `captureWithCdp`'s `finally`
  detaches. If it persists, something in that function threw before reaching
  detach, or is stuck — check the service worker console.
- CDP capture fails outright if real DevTools (or another extension) is
  already attached to the tab — only one debugger client is allowed per
  tab at a time. Close DevTools on that tab and retry.
- `chrome.tabs.captureVisibleTab` is rate-limited by Chrome
  (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`); `captureVisibleTabDataUrl`
  already retries with backoff on that specific error, so a capture that
  fails with it after retries exhausted points to something calling the
  API far more than the normal one-tile-per-`CAPTURE_DELAY_MS` cadence.
- To sanity-check `detectFixedBands`'s output for a specific page (did it
  find a header/sidebar, and how tall/wide), temporarily log `bands` in
  `captureWithScrollStitch` right after the `await detectFixedBands(...)`
  call and read it from the service worker console — there's no other way
  to observe it short of that or a debugger breakpoint, since it's an
  internal value never returned to the popup.
- There's no automated way to verify a capture is *visually* correct
  (right crop, no duplicated/missing bands) — only manual inspection of the
  output image against the real page. This is inherent to the extension
  driving real, live-rendered browser state (scroll position, lazy-loaded
  content, live page elements), not something a unit test can stand in for.

### Verifying against a real live page via Playwright/CDP

When a bug report depends on live rendering (a specific real page, not
something reproducible with a local HTML fixture), reasoning about the fix
isn't enough — reproduce it and check the actual output. The following
approach was used to catch a fix that looked right but wasn't (see
`tasks/lessons.md`), running the real, unmodified `background.js` against
a real, human-verified page:

- **Loading the unpacked extension via `--load-extension`/
  `--disable-extensions-except` flags is unreliable** — it can report no
  error yet register no service worker. Loading it manually through
  `chrome://extensions` → Developer mode → **Load unpacked** in an
  already-running debuggable Chrome instance is the reliable path.
- **`--remote-debugging-port` is silently ignored on Chrome's default
  profile/user-data-dir** (recent versions block this for security) — it
  only binds with an explicit, separate `--user-data-dir`. Confirm the
  port is actually listening (`curl http://127.0.0.1:<port>/json/version`
  or `lsof -iTCP:<port> -sTCP:LISTEN`) rather than trusting that the flag
  was accepted.
- **If the target site has bot/human-verification checks** that block a
  fresh automated profile: launch a *fresh, non-default* profile
  (`--user-data-dir=<throwaway dir> --remote-debugging-port=<port>`),
  headed (not headless) so a human can actually see and solve the check in
  that real window, then have Playwright attach to that already-past-the-
  checkpoint session with `chromium.connectOverCDP('http://127.0.0.1:<port>')`
  instead of launching its own browser.
- **Don't run the extension's source by injecting it into the target
  page's own JS context** (`page.addScriptTag`/`page.evaluate`) — real
  production pages can monkey-patch globals like `window.fetch` (breaking
  `fetch(dataUrl)` for local `data:` URLs), and separately the page's CSP
  (`connect-src`) can block `fetch()` of `data:` URLs at the network layer
  regardless of any monkey-patching. Use a genuinely isolated CDP execution
  context instead — it shares the same DOM/viewport (so scrolling and
  screenshotting the real page still works) but gets a clean, unpolluted
  global scope, closer to what a real extension service worker actually
  gets:

  ```js
  const session = await context.newCDPSession(page);
  const { frameTree } = await session.send('Page.getFrameTree');
  const { executionContextId } = await session.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: `verify-${Date.now()}`, // unique per run — see below
    grantUniveralAccess: false,
  });
  const result = await session.send('Runtime.evaluate', {
    expression, contextId: executionContextId, awaitPromise: true, returnByValue: true,
  });
  ```

  - Use a **unique `worldName` every run** — Chrome reuses an existing
    isolated world for the same name+frame, so a second run's top-level
    `const` declarations collide with the first run's and throw
    `SyntaxError: Identifier '...' has already been declared`.
  - Don't wrap injected source in an IIFE — its top-level `function`
    declarations must land on the isolated world's global object to stay
    visible across *separate* `Runtime.evaluate` calls; an IIFE makes them
    local to itself instead.
  - Even inside an isolated world, `fetch()` of a `data:` URL can still be
    blocked by the page's CSP (CSP is a frame/network-layer restriction,
    not a JS-world one). Decode `data:` URLs with `atob` +
    `Uint8Array` + `new Blob(...)` instead of `fetch(dataUrl)` when this
    matters — pure JS, no network layer involved, so CSP doesn't apply.
  - To let injected code call back out to Playwright for something it
    can't do itself (e.g. a real `page.screenshot()`), Playwright's
    `page.exposeFunction` only binds into the page's *main* world, not an
    isolated one. Use `session.send('Runtime.addBinding', {name,
    executionContextId})` plus a `session.on('Runtime.bindingCalled', ...)`
    listener that resolves a pending promise back in the isolated world via
    a follow-up `Runtime.evaluate` call.
- **For evidence-based pixel debugging** (e.g. confirming something
  repeats at an exact periodic interval — a real bug — versus organic,
  irregularly-spaced content), ImageMagick's `magick` CLI is enough,
  without needing Python imaging libraries: `-resize 1x!` on a cropped
  region averages every row into one pixel, cheap for scanning a tall image
  for color bands; `-crop x1+0+Y` extracts one exact row, and
  `compare -metric AE -fuzz N% rowA.png rowB.png null:` gives an exact (or
  fuzzy) differing-pixel count between two crops.
