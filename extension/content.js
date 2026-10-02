// Receives alerts from the service worker and shows them on this page.
//
// Guarded: the worker injects this file on demand into tabs that were already
// open when the extension was installed, so it can arrive twice in one page
// and must not register a second listener.
if (!window.__intelToastListener) {
  window.__intelToastListener = true;
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type !== 'intel-toast') return;
    window.IntelToast.show(msg.payload, msg.settings);
    reply({ ok: true });
  });
}
