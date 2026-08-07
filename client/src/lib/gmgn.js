// Single source of truth for GMGN quick-buy links.
//
// This was previously duplicated three times (Feed.jsx, Toasts.jsx and
// electron/toast.html) and the copies had DIVERGED into two different URL
// shapes:
//
//   a) https://gmgn.ai/r/<REF>?chain=solana&address=<ca>   (Feed, Toasts)
//   b) https://gmgn.ai/sol/token/<REF>_<ca>                (toast.html)
//
// Only (b) actually opens the token page with referral attribution -- /r/<code>
// is GMGN's referral landing route and ignores the chain/address query pair, so
// (a) dropped the user on the homepage and made "Quick buy" a dead end. Both
// call sites now use (b).
//
// electron/toast.html keeps its own copy because it is a standalone Electron
// renderer with no bundler and cannot import from client/src -- keep the two in
// sync, this file is the reference.

export const GMGN_REFERRAL_CODE = 'ABa59MyI';

/** GMGN's own path segment for a chain. Note these differ from the slugs
 *  DexScreener uses ('sol' here, 'solana' there).
 *
 *  Returns null for a chain GMGN has no page for. It previously fell back to
 *  'sol', which sent every Robinhood/Arc/Stable token to
 *  gmgn.ai/sol/token/<evm address> -- a blank page, because that address does
 *  not exist on Solana. Guessing a chain is worse than having no link. */
export function gmgnChainSlug(raw) {
  const c = (raw || '').toLowerCase();
  if (c.includes('sol')) return 'sol';
  if (c.includes('base')) return 'base';
  if (c.includes('bsc') || c.includes('bnb') || c.includes('binance')) return 'bsc';
  if (c.includes('robin') || c === 'rh') return 'robinhood';
  if (c.includes('stable')) return 'stable';
  if (c.includes('arc')) return 'arc';
  if (c.includes('eth')) return 'eth';
  if (c.includes('tron')) return 'tron';
  return null;
}

/** Token page on GMGN with referral attribution, or null when GMGN has no
 *  page for this chain -- callers must fall back rather than link to nowhere. */
export function gmgnUrl(chain, address) {
  const slug = gmgnChainSlug(chain);
  if (!slug) return null;
  return `https://gmgn.ai/${slug}/token/${GMGN_REFERRAL_CODE}_${address}`;
}

/**
 * A WALLET's page on GMGN — its holdings, trade history and P&L.
 *
 * Deliberately carries NO referral prefix. The token route's `<REF>_<ca>` form
 * is verified; the same shape on the address route is not, and an unverified
 * prefix risks turning a working link into a dead one. The plain route was
 * checked and resolves. Returns null on chains GMGN has no page for, so
 * callers render plain text instead of a broken link.
 */
export function gmgnWalletUrl(chain, wallet) {
  const slug = gmgnChainSlug(chain);
  if (!slug || !wallet) return null;
  return `https://gmgn.ai/${slug}/address/${wallet}`;
}
