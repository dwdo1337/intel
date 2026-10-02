/**
 * parseX decides which of four shapes an X link is, and every downstream
 * decision rests on it: a `tweet` fetches a post, an `account` fetches a
 * profile, a `community` renders a bare link, `other`/`search` render nothing.
 *
 * Getting it wrong is silent in both directions -- a tweet misread as an
 * account shows the author's profile instead of the claim they made, and an
 * account misread as other shows nothing at all while the data was there.
 */
import { parseX } from './x.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const field = (name, url, key, want) => eq(name, parseX(url)?.[key], want);

// --- accounts -------------------------------------------------------------
field('plain account', 'https://x.com/usersdotrade', 'kind', 'account');
field('account handle', 'https://x.com/usersdotrade', 'handle', 'usersdotrade');
field('twitter.com is x.com', 'https://twitter.com/foo', 'kind', 'account');
field('www subdomain', 'https://www.x.com/foo', 'kind', 'account');
field('no scheme', 'x.com/foo', 'kind', 'account');
field('trailing slash', 'https://x.com/foo/', 'kind', 'account');
// The handle is lower-cased so the ten-minute cache cannot hold the same
// account twice under two spellings, which is how a rate limit gets hit.
field('handle lower-cased', 'https://x.com/FooBar', 'handle', 'foobar');
// ...but the LABEL keeps the original case, because that is what people
// recognise and it is what gets displayed.
field('label keeps case', 'https://x.com/FooBar', 'label', '@FooBar');
// A query string is how most links arrive from Telegram.
field('tracking params ignored', 'https://x.com/foo?s=20&t=abc', 'kind', 'account');

// --- posts ----------------------------------------------------------------
field('status is a tweet', 'https://x.com/foo/status/1234567890', 'kind', 'tweet');
field('tweet id extracted', 'https://x.com/foo/status/1234567890', 'tweet', '1234567890');
field('tweet keeps handle', 'https://x.com/foo/status/1234567890', 'handle', 'foo');
field('twitter.com status', 'https://twitter.com/foo/status/99', 'kind', 'tweet');
// A status URL with no id is not a post -- it is a malformed link, and
// treating it as one would fetch `/status/undefined`.
field('status with no id falls back', 'https://x.com/foo/status', 'kind', 'account');

// --- communities ----------------------------------------------------------
field('community', 'https://x.com/i/communities/1234567', 'kind', 'community');
field('community id', 'https://x.com/i/communities/1234567', 'id', 'community:1234567');

// --- things we deliberately do not preview ---------------------------------
field('search', 'https://x.com/search?q=foo', 'kind', 'search');
field('hashtag', 'https://x.com/hashtag/foo', 'kind', 'search');
field('non-x host', 'https://t.me/somechannel', 'kind', 'other');
field('non-x host keeps url', 'https://t.me/somechannel', 'url', 'https://t.me/somechannel');
// A host merely ENDING in x.com must not match -- notx.com is someone else.
field('lookalike host is other', 'https://notx.com/foo', 'kind', 'other');
field('subdomain of x.com matches', 'https://mobile.x.com/foo', 'kind', 'account');

// --- nothing at all -------------------------------------------------------
eq('null url', parseX(null), null);
eq('empty string', parseX(''), null);
eq('undefined', parseX(undefined), null);
eq('bare host, no handle', parseX('https://x.com'), null);
eq('bare host with slash', parseX('https://x.com/'), null);
// Garbage must not throw -- these arrive from chat messages, unvalidated.
field('garbage does not throw', 'not a url at all', 'kind', 'other');

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
