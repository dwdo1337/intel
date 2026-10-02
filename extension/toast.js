// The in-page alert, injected into every tab.
//
// Ported from dex-paid-tracker/extension/toast.js. It lives in a Shadow DOM
// with `all: initial`, which is what stops the host page's CSS reaching it --
// without that, any site with an aggressive reset turns the alert into
// unstyled text on top of its own content.
//
// Styles are inlined rather than imported because a content script cannot
// rely on the page allowing an external stylesheet; a strict CSP would
// silently strip it and leave the same unstyled mess.
(() => {
  if (window.IntelToast) return;

  const CSS = `
  :host { all: initial; }
  /* ONE corner, always the top right. The reference let this be configured
     and that is a setting with no right answer: an alert that can be in four
     places is one you have to look for, and the whole value of a corner strip
     is that your eye already knows where it will be. */
  .stack { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; gap: 10px;
    width: 384px; max-width: calc(100vw - 24px); top: 16px; right: 16px;
    font: 500 13px/1.45 Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #fff; pointer-events: none; }
  .t { pointer-events: auto; position: relative; background: #111214; border: 1px solid #24262c;
    border-radius: 18px; overflow: hidden; cursor: pointer;
    box-shadow: 0 18px 50px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35);
    animation: in .28s cubic-bezier(.2,1.2,.4,1); transition: opacity .2s, transform .2s; }
  .t.out { opacity: 0; transform: translateX(16px) scale(.98); }
  @keyframes in { from { opacity: 0; transform: translateX(24px) scale(.97); } }
  /* The left edge carries the weight: green for a new call, white for a note
     about something already starred. Same split the deck's alert layer uses. */
  .t::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--c, #2bf08c); }
  .t.note { --c: #fff; }
  .in { padding: 13px 14px 12px 16px; }
  .hd { display: flex; align-items: center; gap: 11px; }
  .ic { width: 46px; height: 46px; border-radius: 12px; object-fit: cover; background: #1a1b1f;
    flex: none; display: grid; place-items: center; font-weight: 800; font-size: 18px; color: #8e929b; }
  .id { min-width: 0; flex: 1; }
  .tk { display: flex; align-items: center; gap: 7px; font-size: 17px; font-weight: 800;
    letter-spacing: -.2px; white-space: nowrap; }
  .tk span { overflow: hidden; text-overflow: ellipsis; }
  .sub { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px;
    color: #8e929b; white-space: nowrap; overflow: hidden; }
  .sub .nm { overflow: hidden; text-overflow: ellipsis; }
  .sub .mc { color: #fff; font-weight: 700; flex: none; }
  .cp { flex: none; align-self: flex-start; border: 1px solid #2e313a; background: #1a1b1f; color: #fff;
    border-radius: 10px; padding: 7px 12px; font: 700 12px Inter, system-ui, sans-serif; cursor: pointer; }
  .cp:hover { background: #22242a; }
  .cp.ok { background: #2bf08c; border-color: #2bf08c; color: #04120a; }
  .x { position: absolute; top: 6px; right: 7px; width: 20px; height: 20px; border: 0; border-radius: 6px;
    background: transparent; color: #5c6069; font-size: 14px; line-height: 20px; cursor: pointer;
    opacity: 0; transition: opacity .15s; }
  .t:hover .x { opacity: 1; } .x:hover { background: #22242a; color: #fff; }
  .who { margin-top: 10px; padding: 9px 11px; background: #17181c; border-radius: 12px;
    color: #d6d8dd; font-size: 13px; line-height: 1.5; }
  .who b { color: #fff; }
  .src { display: block; margin-bottom: 3px; font-size: 11px; font-weight: 700; color: #8e929b; }
  /* The narrative, one line: who the project claims to be and how many people
     follow it. This is the fact that most often decides whether the tab is
     worth switching to at all. */
  .nar { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 8px 10px;
    background: #17181c; border-radius: 12px; }
  .nar img { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; background: #24262c; flex: none; }
  .nar .h { min-width: 0; flex: 1; font-size: 12px; font-weight: 700; color: #d6d8dd;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nar .v { width: 13px; height: 13px; border-radius: 50%; background: #1d9bf0; color: #fff;
    font-size: 8px; font-weight: 900; display: grid; place-items: center; flex: none; }
  .nar .f { font-size: 12px; font-weight: 900; color: #fff; flex: none; }
  /* A linked POST replaces the profile strip rather than sitting under it.
     The caller pointed at a claim; the claim is the content, and stacking
     both would make a corner strip taller than the page it sits on. */
  .tw { margin-top: 8px; padding: 9px 11px; background: #17181c; border-radius: 12px; }
  .tw .who { display: flex; align-items: center; gap: 7px; }
  .tw .who img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover;
    background: #24262c; flex: none; }
  .tw .who .h { min-width: 0; flex: 1; font-size: 11.5px; font-weight: 700; color: #8e929b;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tw .who .f { font-size: 11.5px; font-weight: 800; color: #d6d8dd; flex: none; }
  /* Four lines, then it clips. Enough to judge the claim, not so much that
     the alert becomes something you have to close before you can work. */
  .tw p { margin: 7px 0 0; font-size: 13px; line-height: 1.45; color: #fff; font-weight: 500;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4;
    overflow: hidden; white-space: pre-line; word-break: break-word; }
  .tw .pic { display: block; width: 100%; max-height: 132px; object-fit: cover;
    border-radius: 9px; margin-top: 8px; background: #24262c; }
  .tw .st { display: flex; gap: 12px; margin-top: 7px; font-size: 11.5px; font-weight: 700; color: #5c6069; }
  .bar { height: 2px; background: #1a1b1f; }
  .bar i { display: block; height: 100%; width: 100%; background: var(--c, #2bf08c); transform-origin: left; }
  `;

  let root = null, stack = null;

  function ensure() {
    // Re-created when the host page replaces its own documentElement, which
    // single-page apps do on navigation and which would otherwise orphan the
    // stack and silently stop every later alert from appearing.
    if (!root || !document.documentElement.contains(root.host)) {
      const host = document.createElement('intel-command-deck');
      host.style.cssText = 'all:initial';
      (document.body || document.documentElement).appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
      stack = document.createElement('div');
      stack.className = 'stack';
      root.appendChild(stack);
    }
    return stack;
  }

  const money = n => n == null ? null
    : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B'
    : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K'
    : '$' + Math.round(n);

  const count = n => n == null ? '—'
    : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K'
    : String(n);

  function show(a, settings) {
    const s = settings || {};
    const ttl = Math.max(4000, (s.seconds || 15) * 1000);
    const el = document.createElement('div');
    el.className = 't' + (a.tier === 'note' ? ' note' : '');

    const mc = money(a.mcap);
    const icon = a.image
      ? `<img class="ic" src="${esc(a.image)}" alt="">`
      : `<div class="ic">${esc((a.symbol || '?').slice(0, 1))}</div>`;

    // Who called it and where. The whole point of the deck, so it is in the
    // alert verbatim rather than summarised into "a source".
    const who = (a.chat_name || a.author)
      ? `<div class="who"><span class="src">${a.tier === 'note' ? 'WATCHLIST' : 'CALLED BY'}</span>` +
        `${a.author ? `<b>${esc(a.author)}</b>` : ''}${a.author && a.chat_name ? ' · ' : ''}` +
        `${a.chat_name ? esc(a.chat_name) : ''}</div>`
      : '';

    // What the token IS. A linked post wins over the profile: the post is the
    // claim the caller was pointing at, where the profile is only who made it.
    let nar = '';
    if (a.tweet && a.tweet.text) {
      const x = a.x || {};
      nar =
        `<div class="tw">` +
          `<div class="who">` +
            `${x.avatar ? `<img src="${esc(x.avatar)}" alt="">` : ''}` +
            `<span class="h">${esc(x.name || '')}${x.handle ? ` @${esc(x.handle)}` : ''}</span>` +
            `${x.followers != null ? `<span class="f">${count(x.followers)}</span>` : ''}` +
          `</div>` +
          `<p>${esc(a.tweet.text)}</p>` +
          `${a.tweet.image ? `<img class="pic" src="${esc(a.tweet.image)}" alt="">` : ''}` +
          `${(a.tweet.likes != null || a.tweet.views != null)
            ? `<div class="st">${a.tweet.likes != null ? `<span>♥ ${count(a.tweet.likes)}</span>` : ''}` +
              `${a.tweet.views != null ? `<span>👁 ${count(a.tweet.views)}</span>` : ''}</div>`
            : ''}` +
        `</div>`;
    } else if (a.x) {
      nar =
        `<div class="nar">${a.x.avatar ? `<img src="${esc(a.x.avatar)}" alt="">` : ''}` +
        `<span class="h">${esc(a.x.name || ('@' + a.x.handle))} · @${esc(a.x.handle)}</span>` +
        `${a.x.verified ? '<i class="v">✓</i>' : ''}` +
        `<span class="f">${count(a.x.followers)}</span></div>`;
    }

    el.innerHTML = `
      <div class="in">
        <div class="hd">
          ${icon}
          <div class="id">
            <div class="tk"><span>$${esc(a.symbol || '?')}</span></div>
            <div class="sub">
              <span class="nm">${esc(a.name || '')}</span>
              ${mc ? `<span class="mc">${mc}</span>` : ''}
            </div>
          </div>
          <button class="cp">Copy CA</button>
        </div>
        ${who}
        ${nar}
      </div>
      <div class="bar"><i></i></div>
      <button class="x" aria-label="Dismiss">✕</button>`;

    const kill = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    };

    el.querySelector('.x').onclick = (e) => { e.stopPropagation(); kill(); };
    el.querySelector('.cp').onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(a.ca || '').then(() => {
        const b = e.target;
        b.textContent = 'Copied';
        b.classList.add('ok');
        setTimeout(() => { b.textContent = 'Copy CA'; b.classList.remove('ok'); }, 1200);
      }).catch(() => { /* clipboard blocked on this page -- the deck still has it */ });
    };
    // Clicking the body opens the deck ON THIS TOKEN, which is the only
    // action an alert about one token can usefully have.
    el.onclick = () => {
      chrome.runtime.sendMessage({ type: 'open', ca: a.ca });
      kill();
    };

    ensure().prepend(el);

    const bar = el.querySelector('.bar i');
    bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: ttl, fill: 'forwards' });
    const timer = setTimeout(kill, ttl);
    // Hovering holds it. An alert that vanishes while you are reading it is
    // worse than no alert, because you know you missed something.
    el.onmouseenter = () => { clearTimeout(timer); bar.getAnimations().forEach(x => x.pause()); };
    el.onmouseleave = () => { bar.getAnimations().forEach(x => x.play()); setTimeout(kill, 2500); };

    while (stack.children.length > 4) stack.lastElementChild.remove();
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.IntelToast = { show };
})();
