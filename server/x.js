/**
 * The narrative behind a call: the X account or post attached to the token.
 *
 * A contract address and a market cap say what was bought. They do not say
 * what it IS, and that is the thing you actually judge a call on -- whether
 * the account is three days old with 45 followers, or a real project, or a
 * post that is already doing numbers. The deck carried the link and nothing
 * else, so that judgement happened outside the app every single time.
 *
 * Ported from dex-paid-tracker/src/enrich.js. Source: FxTwitter's public API,
 * which needs no key and no account -- deliberately, because `app/config.json`
 * already holds enough live credentials and a feature like this is not worth
 * another one.
 *
 * HONEST DATA: every path here returns null rather than a guess. No profile,
 * a handle that 404s, a timeout, a community link FxTwitter cannot read --
 * all of them render nothing at all. An X block that appears means X answered.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) intel-command-deck';

async function json(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify an X link. x.com/handle, x.com/handle/status/123,
 * x.com/i/communities/123, and the twitter.com forms of each.
 *
 * `search` and `other` are returned rather than dropped so the caller can
 * tell "this is a link we choose not to preview" from "there was no link".
 */
export function parseX(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).startsWith('http') ? url : `https://${url}`);
    if (!/(^|\.)(x|twitter)\.com$/i.test(u.hostname)) return { kind: 'other', id: url, url };
    const p = u.pathname.split('/').filter(Boolean);
    if (p[0] === 'i' && p[1] === 'communities' && p[2]) {
      return { kind: 'community', id: `community:${p[2]}`, label: `Community ${p[2].slice(-6)}`, url };
    }
    if (p[0] === 'search' || p[0] === 'hashtag') {
      return { kind: 'search', id: url, label: decodeURIComponent(u.search || p[1] || ''), url };
    }
    if (!p[0]) return null;
    const handle = p[0].toLowerCase();
    if (p[1] === 'status' && p[2]) return { kind: 'tweet', id: `@${handle}`, handle, label: `@${p[0]}`, tweet: p[2], url };
    return { kind: 'account', id: `@${handle}`, handle, label: `@${p[0]}`, url };
  } catch {
    return { kind: 'other', id: url, url };
  }
}

/**
 * Profiles are cached for ten minutes.
 *
 * Not to be polite to FxTwitter -- because the same account fronts every coin
 * in a series, and a room calling six of them in a minute would otherwise
 * fetch the identical profile six times while the user waits for the card.
 *
 * A failed lookup is cached too, as `null`. Without that, a handle that does
 * not exist is retried on every single render of that card.
 */
const cache = new Map();
const TTL_MS = 10 * 60_000;

async function profileFor(handle) {
  const hit = cache.get(handle);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.profile;
  let profile = null;
  try {
    const u = (await json(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`)).user;
    if (u) {
      profile = {
        handle: u.screen_name,
        name: u.name,
        avatar: u.avatar_url || null,
        banner: u.banner_url || null,
        bio: u.description || '',
        location: u.location || '',
        website: u.website?.url || null,
        followers: u.followers ?? null,
        following: u.following ?? null,
        tweets: u.tweets ?? null,
        joined: u.joined ? Date.parse(u.joined) : null,
        verified: !!u.verification?.verified,
        verifiedType: u.verification?.type || null,
      };
    }
  } catch {
    profile = null;
  }
  cache.set(handle, { at: Date.now(), profile });
  return profile;
}

/**
 * The narrative block's data: a profile for an account link, profile + post
 * for a status link, a bare label for a community (FxTwitter cannot read
 * those, and inventing a preview for them would be exactly the wrong move).
 */
export async function xInfo(x) {
  if (!x || x.kind === 'other' || x.kind === 'search') return null;
  if (x.kind === 'community') return { kind: 'community', url: x.url, label: x.label };

  const out = { kind: x.kind, url: x.url, profile: await profileFor(x.handle) };

  if (x.kind === 'tweet' && x.tweet) {
    try {
      const t = (await json(`https://api.fxtwitter.com/status/${x.tweet}`)).tweet;
      if (t) {
        out.tweet = {
          text: t.text || '',
          created: t.created_at ? Date.parse(t.created_at) : null,
          likes: t.likes ?? null,
          retweets: t.retweets ?? null,
          replies: t.replies ?? null,
          views: t.views ?? null,
          media: (t.media?.all || []).slice(0, 4).map(m => ({
            type: m.type,
            url: m.type === 'photo' ? m.url : (m.thumbnail_url || m.url),
          })),
          quote: t.quote ? { handle: t.quote.author?.screen_name || null, text: (t.quote.text || '').slice(0, 280) } : null,
        };
      }
      // A deleted or protected author still leaves the post readable, so take
      // the author off the post rather than showing a card with no identity.
      if (!out.profile && t?.author) {
        out.profile = {
          handle: t.author.screen_name, name: t.author.name,
          avatar: t.author.avatar_url || null, followers: t.author.followers ?? null,
        };
      }
    } catch { /* the profile alone is still worth showing */ }
  }

  // Nothing came back at all -- no profile, no post. Return null so the card
  // renders no block, rather than an empty frame implying X had nothing to say.
  if (!out.profile && !out.tweet && out.kind !== 'community') return null;
  return out;
}

/** Convenience: straight from a stored twitter_url to the block's data. */
export async function xInfoForUrl(url) {
  const parsed = parseX(url);
  return parsed ? xInfo(parsed) : null;
}

export const _test = { cache };
