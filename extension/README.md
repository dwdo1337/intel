# intel. alerts — browser extension

Puts call alerts **inside whatever tab you are looking at**. Nothing goes to
the Windows notification centre.

## Install

1. Start the deck: `npm start` in `app/`, then open <http://localhost:5050>.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** → pick this folder.

The toolbar icon shows a red **OFF** badge whenever the deck is not running,
so "no alerts" and "nothing is listening" never look the same.

## What it does and does not decide

It decides **nothing** about which calls are worth an alert. The deck owns the
chain switches and the metric thresholds, and the server only broadcasts what
has already passed that gate. Two places deciding whether to interrupt you is
two places that can disagree — and the one in the browser is the one you would
never think to check.

The popup only controls the alert itself: on/off, and how long it stays up.

## How it connects

A plain WebSocket to `localhost:5050/ws`. The deck itself speaks Socket.IO and
still does; a Manifest V3 service worker has no bundler, and pulling
socket.io-client into it to carry four message shapes would not be worth it.
The socket is broadcast-only — the extension never sends anything, and nothing
arriving on it is read.
