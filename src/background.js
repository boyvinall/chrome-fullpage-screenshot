'use strict';

// Owns the CDP debugger session lifecycle and the scroll-and-stitch capture
// loop. Both live in the background service worker rather than the popup
// because MV3 popups are torn down the instant they lose focus — if
// attach/capture/detach (or a multi-second scroll-and-capture loop) ran in
// the popup's own document, closing the popup mid-capture would kill that
// JS context before cleanup ever ran: for CDP, a `chrome.debugger` session
// stuck attached to the tab (stuck "started debugging this browser" banner,
// DevTools unable to attach); for scroll-and-stitch, the page left scrolled
// to wherever the loop happened to be. The service worker isn't tied to the
// popup's lifetime, so the capture — and its cleanup — completes regardless
// of whether the popup is still around to receive the result.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'capture') {
    return false;
  }
  const capture = message.method === 'cdp' ? captureWithCdp : captureWithScrollStitch;
  capture(message.tabId, message.scope)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // keep the message channel open for the async response
});

// Mirrors the CDP calls DevTools itself makes for its "Capture full size
// screenshot" and "Capture screenshot" Command Menu actions: resize the
// capture region with Page.getLayoutMetrics + Page.captureScreenshot's
// captureBeyondViewport/clip, rather than scrolling the page and stitching.
//
// This handles nested scroll containers and sticky/fixed elements correctly
// (nothing on the page ever scrolls), but anything gated on a real scroll
// event firing — lazy-loaded images, virtualized lists, infinite-scroll
// feeds — renders blank or truncated. See README's "Choosing a capture
// method" for the full trade-off against captureWithScrollStitch.
async function captureWithCdp(tabId, scope) {
  await chrome.debugger.attach({ tabId }, '1.3');
  let data;
  try {
    const params = { format: 'png' };
    if (scope === 'full') {
      // cssContentSize, not contentSize — contentSize is reported in
      // physical/device pixels, while captureScreenshot's clip (at
      // scale: 1) expects CSS pixels. Using contentSize crops or
      // misscales the capture on any HiDPI display or non-100% zoom.
      const { cssContentSize } = await chrome.debugger.sendCommand(
        { tabId },
        'Page.getLayoutMetrics'
      );
      params.captureBeyondViewport = true;
      params.clip = {
        x: 0,
        y: 0,
        width: cssContentSize.width,
        height: cssContentSize.height,
        scale: 1,
      };
    }
    ({ data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params));
  } finally {
    // Report a failed detach instead of silently treating cleanup as
    // successful, but don't let it mask an error from the try block above.
    await chrome.debugger.detach({ tabId }).catch((err) => {
      console.error(`Failed to detach debugger from tab ${tabId}:`, err);
    });
  }
  return data; // base64-encoded PNG
}

// The default capture method. Scrolls the real page in viewport-height
// steps, screenshots each step with chrome.tabs.captureVisibleTab, and
// stitches the tiles together on an OffscreenCanvas.
//
// Because it drives a real scroll, content gated on scroll/intersection
// events (lazy-loaded images, virtualized lists) renders correctly — the
// trade-off CDP can't make. What it can't do: follow a scroll container
// other than the page's own window (a lot of SPAs scroll some inner `<div>`
// instead of `<body>`), and it can't tell a sticky/fixed header from regular
// content, so those repeat once per tile in the stitched image. See
// README's "Choosing a capture method".
async function captureWithScrollStitch(tabId, scope) {
  // windowId is invariant for the whole capture session — look it up once
  // here instead of re-fetching it inside captureVisibleTabDataUrl on every
  // single tile/probe capture.
  const { windowId } = await chrome.tabs.get(tabId);

  if (scope !== 'full') {
    // Nothing to scroll or stitch — one shot, and (unlike CDP) it doesn't
    // even need the debugger permission.
    return dataUrlToBase64(await captureVisibleTabDataUrl(windowId));
  }

  const metrics = await getPageMetrics(tabId);
  if (metrics.scrollHeight <= metrics.viewportHeight) {
    // Page already fits in one viewport; same single-shot path.
    return dataUrlToBase64(await captureVisibleTabDataUrl(windowId));
  }

  // Everything from here on scrolls the real page (detectFixedBands' probes
  // included), so the restore-scroll cleanup below has to cover all of it —
  // not just the main tile loop — or a failure during band detection leaves
  // the page stranded mid-probe instead of back where the user had it.
  try {
    const bands = await detectFixedBands(tabId, windowId, metrics);
    // Any detected header/footer band re-shows the same rows at every
    // scroll step, so shrink the step by that much — the next tile's
    // uncropped middle then supplies exactly the document rows the fixed
    // band was hiding, instead of leaving a gap.
    const effectiveStep = Math.max(
      metrics.viewportHeight - bands.topPx - bands.bottomPx,
      Math.round(metrics.viewportHeight * 0.1)
    );
    const positions = buildScrollPositions(metrics.scrollHeight, metrics.viewportHeight, effectiveStep);

    const tiles = [];
    for (let i = 0; i < positions.length; i++) {
      const y = positions[i];
      if (i === 0 && bands.zeroCapture) {
        // detectFixedBands already captured this position while probing.
        tiles.push({ y, dataUrl: bands.zeroCapture });
        continue;
      }
      await scrollTabTo(tabId, y);
      // Give the page a moment to repaint at the new scroll position (and
      // let any scroll-triggered lazy content load) before capturing, and
      // keep us comfortably under Chrome's captureVisibleTab rate limit.
      await sleep(CAPTURE_DELAY_MS);
      tiles.push({ y, dataUrl: await captureVisibleTabDataUrl(windowId) });
    }

    return stitchTiles(tiles, metrics, bands);
  } finally {
    // Leave the page where the user had it, not scrolled to the bottom.
    await scrollTabTo(tabId, metrics.originalScrollY);
  }
}

// The cunning bit: scroll to two nearby positions and diff the
// screenshots. Real content shifts between them, so any row or column
// that comes back byte-identical despite the page having genuinely
// scrolled can only be something that doesn't move with the page at all
// — a position:fixed/sticky header, footer, or sidebar. Knowing its size
// lets the stitching step draw it once instead of once per tile.
const PROBE_BASE_PX = 48;
const PROBE_DELTA_PX = 48;

async function detectFixedBands(tabId, windowId, metrics) {
  const scrollRange = metrics.scrollHeight - metrics.viewportHeight;
  if (scrollRange < PROBE_BASE_PX + PROBE_DELTA_PX) {
    // Not enough room to nudge the page by a reliable amount — skip the
    // optimization rather than risk a false read from a too-small probe.
    return { topPx: 0, bottomPx: 0, leftPx: 0, rightPx: 0, zeroCapture: null };
  }

  // Captured for its own sake — this becomes tile 0 in the main loop — but
  // deliberately NOT used as one of the two probe frames. A lot of sites
  // restyle their header the instant scrollY leaves 0 (adding a shadow or
  // border once "scrolled"), which would make position 0 diff differently
  // from every other position even though the header is genuinely fixed
  // everywhere past that threshold. Comparing two already-scrolled
  // positions instead avoids that false negative.
  const zeroCapture = await captureVisibleTabDataUrl(windowId);

  await scrollTabTo(tabId, PROBE_BASE_PX);
  await sleep(CAPTURE_DELAY_MS);
  const probeA = await captureVisibleTabDataUrl(windowId);

  await scrollTabTo(tabId, PROBE_BASE_PX + PROBE_DELTA_PX);
  await sleep(CAPTURE_DELAY_MS);
  const probeB = await captureVisibleTabDataUrl(windowId);

  const [bitmapA, bitmapB] = await Promise.all([
    dataUrlToImageBitmap(probeA),
    dataUrlToImageBitmap(probeB),
  ]);
  let bands;
  try {
    bands = compareForFixedBands(bitmapA, bitmapB, metrics.devicePixelRatio);
  } finally {
    bitmapA.close();
    bitmapB.close();
  }
  return { ...bands, zeroCapture };
}

// Scans in from all four edges of two same-size screenshots for contiguous
// rows/columns that are pixel-for-pixel identical, and returns their sizes
// in CSS px. Catches both shapes a fixed element takes: a header/footer
// spans the full *width* and sits at the top/bottom edge (rows match); a
// sidebar spans the full *height* and sits at the left/right edge (columns
// match). Errs toward under-detecting: a bad or ambiguous read returns
// zero-size bands, which just falls back to today's behavior (draw every
// tile in full) rather than risk cropping away real content.
function compareForFixedBands(bitmapA, bitmapB, devicePixelRatio) {
  const { width, height } = bitmapA;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(bitmapA, 0, 0);
  const dataA = ctx.getImageData(0, 0, width, height).data;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmapB, 0, 0);
  const dataB = ctx.getImageData(0, 0, width, height).data;

  // Real fixed headers are rarely *perfectly* static — a blinking caret, an
  // unread-count badge, a subtly-animated icon — so demanding byte-exact
  // equality across an entire row/column is too strict: one live pixel
  // anywhere in an otherwise-fixed 3000px-wide header row fails the whole
  // row and truncates detection at that point, well short of the header's
  // real height. Tolerate a small, bounded amount of per-row/per-column
  // noise instead of requiring every pixel to match.
  const CHANNEL_TOLERANCE = 24;
  const pixelDiffers = (offset) =>
    Math.abs(dataA[offset] - dataB[offset]) > CHANNEL_TOLERANCE ||
    Math.abs(dataA[offset + 1] - dataB[offset + 1]) > CHANNEL_TOLERANCE ||
    Math.abs(dataA[offset + 2] - dataB[offset + 2]) > CHANNEL_TOLERANCE;

  const rowBytes = width * 4;
  const maxRowDiffPixels = Math.max(4, Math.round(width * 0.01));
  const rowsMatch = (row) => {
    const start = row * rowBytes;
    let diffCount = 0;
    for (let x = 0; x < width; x++) {
      if (pixelDiffers(start + x * 4)) {
        diffCount++;
        if (diffCount > maxRowDiffPixels) {
          return false;
        }
      }
    }
    return true;
  };
  const maxColDiffPixels = Math.max(4, Math.round(height * 0.01));
  const colsMatch = (col) => {
    const colOffset = col * 4;
    let diffCount = 0;
    for (let row = 0; row < height; row++) {
      if (pixelDiffers(row * rowBytes + colOffset)) {
        diffCount++;
        if (diffCount > maxColDiffPixels) {
          return false;
        }
      }
    }
    return true;
  };

  let topRows = 0;
  while (topRows < height && rowsMatch(topRows)) {
    topRows++;
  }
  let bottomRows = 0;
  while (bottomRows < height - topRows && rowsMatch(height - 1 - bottomRows)) {
    bottomRows++;
  }
  let leftCols = 0;
  while (leftCols < width && colsMatch(leftCols)) {
    leftCols++;
  }
  let rightCols = 0;
  while (rightCols < width - leftCols && colsMatch(width - 1 - rightCols)) {
    rightCols++;
  }

  // A degenerate probe — nothing moved, or the whole frame happens to
  // match — is a signal to distrust, not a giant fixed element. Bail out
  // to "assume nothing is fixed" instead of cropping away real content.
  const maxBandRows = Math.floor(height * 0.4);
  if (topRows > maxBandRows || bottomRows > maxBandRows || topRows + bottomRows >= height) {
    topRows = 0;
    bottomRows = 0;
  }
  const maxBandCols = Math.floor(width * 0.4);
  if (leftCols > maxBandCols || rightCols > maxBandCols || leftCols + rightCols >= width) {
    leftCols = 0;
    rightCols = 0;
  }

  // A one- or two-row/column coincidental match (e.g. a shared background
  // color at the seam) isn't a real fixed element; require a meaningful band.
  const minBandRows = Math.max(4, Math.round(2 * devicePixelRatio));
  const minBandCols = minBandRows;
  return {
    topPx: topRows < minBandRows ? 0 : Math.round(topRows / devicePixelRatio),
    bottomPx: bottomRows < minBandRows ? 0 : Math.round(bottomRows / devicePixelRatio),
    leftPx: leftCols < minBandCols ? 0 : Math.round(leftCols / devicePixelRatio),
    rightPx: rightCols < minBandCols ? 0 : Math.round(rightCols / devicePixelRatio),
  };
}

const CAPTURE_DELAY_MS = 300;

async function getPageMetrics(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      originalScrollY: window.scrollY,
    }),
  });
  return result;
}

async function scrollTabTo(tabId, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (top) => window.scrollTo({ top, left: 0, behavior: 'instant' }),
    args: [y],
  });
}

// [0, step, 2*step, ...], stopping once a further step would scroll past
// the bottom, then adding one final position clamped so the last tile
// ends exactly at scrollHeight instead of overshooting into blank space
// below the page. `step` is normally viewportHeight, but is shrunk by
// detectFixedBands' findings when a fixed header/footer is present.
function buildScrollPositions(scrollHeight, viewportHeight, step = viewportHeight) {
  const lastY = scrollHeight - viewportHeight;
  const positions = [];
  let y = 0;
  while (y < lastY) {
    positions.push(y);
    y += step;
  }
  positions.push(lastY);
  return positions;
}

async function captureVisibleTabDataUrl(windowId) {
  // Chrome throttles chrome.tabs.captureVisibleTab (MAX_CAPTURE_VISIBLE_
  // TAB_CALLS_PER_SECOND); CAPTURE_DELAY_MS keeps normal captures well
  // under that, but retry with backoff instead of assuming the delay is
  // always enough (a slow tab, a long page, or other extensions sharing
  // the same per-second budget can still trip it).
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const rateLimited = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(err.message || '');
      if (!rateLimited || attempt === maxAttempts) {
        throw err;
      }
      await sleep(500);
    }
  }
}

// `bands` (from detectFixedBands) tells us which rows/columns of every
// tile are just a fixed header/footer/sidebar repeating, not new content.
//
// Vertically: tile 0 keeps its top in full (the header's one real,
// correct appearance); the last tile keeps its bottom in full (same logic
// for a footer). Every other tile has both cropped out before being drawn,
// landing at a shifted destination Y so the previous tile's real content
// lines up underneath with no gap (see captureWithScrollStitch's
// effectiveStep — that's what makes this alignment work out exactly).
//
// Horizontally: only tile 0 draws a detected left/right sidebar — since
// it's fixed, every tile's copy of it is identical, so there's nothing to
// gain from redrawing it, and no scroll trick reveals whatever's behind
// it. Every other tile is cropped to just the part of the row that
// actually scrolls, at the same X position (no shift — unlike the
// vertical case, there's no gap to close here, just repeated content to
// skip). This leaves the sidebar's column blank for the rest of the page
// below tile 0, rather than repeating it — a plain gap reads as far less
// broken than the same box duplicated tile after tile.
async function stitchTiles(tiles, metrics, bands) {
  const { viewportWidth, viewportHeight, scrollHeight, devicePixelRatio } = metrics;
  const canvas = new OffscreenCanvas(
    Math.round(viewportWidth * devicePixelRatio),
    Math.round(scrollHeight * devicePixelRatio)
  );
  const ctx = canvas.getContext('2d');

  // Document-space (CSS px) cursor tracking how far down the page has
  // actually been painted so far.
  let paintedUpToCss = 0;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const isFirst = i === 0;
    const isLast = i === tiles.length - 1;
    const bitmap = await dataUrlToImageBitmap(tile.dataUrl);

    // Never crop further than what's already painted — a smaller-than-
    // expected gap (e.g. the clamped final tile) shrinks the crop instead
    // of leaving a blank strip.
    const topCropCss = Math.min(bands.topPx, Math.max(0, paintedUpToCss - tile.y));
    const bottomCropCss = isLast ? 0 : bands.bottomPx;
    const leftCropCss = isFirst ? 0 : bands.leftPx;
    const rightCropCss = isFirst ? 0 : bands.rightPx;

    const srcTop = Math.round(topCropCss * devicePixelRatio);
    const srcBottom = Math.round(bottomCropCss * devicePixelRatio);
    const srcLeft = Math.round(leftCropCss * devicePixelRatio);
    const srcRight = Math.round(rightCropCss * devicePixelRatio);
    const srcHeight = bitmap.height - srcTop - srcBottom;
    const srcWidth = bitmap.width - srcLeft - srcRight;
    if (srcHeight > 0 && srcWidth > 0) {
      ctx.drawImage(
        bitmap,
        srcLeft,
        srcTop,
        srcWidth,
        srcHeight,
        srcLeft, // no horizontal shift — the cropped sidebar simply isn't redrawn
        Math.round((tile.y + topCropCss) * devicePixelRatio),
        srcWidth,
        srcHeight
      );
      paintedUpToCss = tile.y + viewportHeight - bottomCropCss;
    }
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToBase64(blob);
}

async function dataUrlToImageBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function dataUrlToBase64(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

// No FileReader in a service worker, so base64-encode manually. Chunked to
// avoid blowing the call stack on String.fromCharCode.apply for a
// full-page-sized image.
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
