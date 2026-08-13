'use strict';

const els = {
  scopeFull: document.getElementById('scope-full'),
  methodCdp: document.getElementById('method-cdp'),
  outputDownload: document.getElementById('output-download'),
  captureBtn: document.getElementById('capture-btn'),
  status: document.getElementById('status'),
  cdpHint: document.getElementById('cdp-hint'),
};

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

function getScope() {
  return els.scopeFull.checked ? 'full' : 'viewport';
}

function getMethod() {
  return els.methodCdp.checked ? 'cdp' : 'stitch';
}

function getOutput() {
  return els.outputDownload.checked ? 'download' : 'clipboard';
}

// The debugger banner only applies to the CDP method — don't show a hint
// that's simply untrue for the (now default) scroll-and-stitch method.
function updateCdpHint() {
  els.cdpHint.hidden = getMethod() !== 'cdp';
}

document.getElementsByName('method').forEach((radio) => {
  radio.addEventListener('change', updateCdpHint);
});
updateCdpHint();

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    throw new Error('No active tab found.');
  }
  if (!/^https?:|^file:/i.test(tab.url || '')) {
    throw new Error(
      "This page can't be captured — chrome://, the Web Store, and other " +
        'extension pages are off-limits to both capture methods.'
    );
  }
  return tab;
}

// The actual capture (CDP attach/capture/detach, or the scroll-and-stitch
// loop) runs in the background service worker (see background.js), not
// here — a popup can be torn down mid-await the moment it loses focus,
// which would otherwise abort the capture with no way to clean up after it.
async function captureScreenshot(tabId, scope, method) {
  const response = await chrome.runtime.sendMessage({ type: 'capture', tabId, scope, method });
  if (!response?.ok) {
    throw new Error(response?.error || 'Capture failed.');
  }
  return response.data; // base64-encoded PNG
}

async function base64ToBlob(base64, mime) {
  const res = await fetch(`data:${mime};base64,${base64}`);
  return res.blob();
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function downloadImage(base64) {
  const blob = await base64ToBlob(base64, 'image/png');
  const url = URL.createObjectURL(blob);
  const filename = `screenshot-${timestamp()}.png`;
  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    // Wait for the download manager to actually finish reading the blob
    // before revoking its URL — a fixed timer would either revoke too
    // early for a large full-page capture or hold memory needlessly long
    // for a small one.
    await new Promise((resolve, reject) => {
      function onChanged(delta) {
        if (delta.id !== downloadId || !delta.state) {
          return;
        }
        if (delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        } else if (delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error(`Download failed: ${delta.error?.current || 'interrupted'}`));
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return filename;
}

async function copyImageToClipboard(base64) {
  const blob = await base64ToBlob(base64, 'image/png');
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

els.captureBtn.addEventListener('click', async () => {
  els.captureBtn.disabled = true;
  setStatus('Capturing…');
  try {
    const tab = await getActiveTab();
    const scope = getScope();
    const method = getMethod();
    const output = getOutput();
    const base64 = await captureScreenshot(tab.id, scope, method);
    if (output === 'download') {
      const filename = await downloadImage(base64);
      setStatus(`Saved as ${filename}`);
    } else {
      await copyImageToClipboard(base64);
      setStatus('Copied to clipboard.');
    }
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', true);
  } finally {
    els.captureBtn.disabled = false;
  }
});
