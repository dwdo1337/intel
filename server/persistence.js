/**
 * Disk persistence for the in-memory signal store.
 *
 * Why this exists: the whole point of intel. is "don't miss a call," but
 * until now every hit, every mention history, and every entry-mcap anchor
 * lived only in RAM. Any crash, restart, or rebuild wiped it -- including
 * the entry mcap, which is the anchor the multiplier is computed against,
 * so a restart silently reset every token's "since call" performance to 1x.
 *
 * Design notes:
 *  - Atomic writes (tmp file + rename) so a crash mid-write can't leave a
 *    truncated/corrupt JSON file that bricks the next startup.
 *  - Debounced: signals can arrive in bursts; we don't want a disk write
 *    per mention. Coalesce into at most one write per SAVE_DEBOUNCE_MS.
 *  - Fail-soft on load: a corrupt or unreadable store must never prevent
 *    the app from starting. Worst case we start empty, same as before.
 *  - Capped on save: only the most recent MAX_PERSISTED hits are written,
 *    so the file can't grow unbounded across long-running sessions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';

const SAVE_DEBOUNCE_MS = 2000;
const MAX_PERSISTED = 500;

export class HitStorePersistence {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.tmpPath = filePath + '.tmp';
    this.log = logger || (() => {});
    this._timer = null;
    this._pending = null;
  }

  /**
   * Load a previously persisted store. Returns { hits: Map, order: string[] }.
   * Always returns a usable (possibly empty) result -- never throws.
   */
  load() {
    const empty = { hits: new Map(), order: [] };
    try {
      if (!existsSync(this.filePath)) return empty;
      const raw = readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return empty;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.hits)) return empty;

      const hits = new Map();
      for (const hit of parsed.hits) {
        if (hit && typeof hit.ca === 'string') hits.set(hit.ca, hit);
      }
      // Only keep ordering entries that actually resolve to a loaded hit,
      // so a partially-written file can't leave dangling ids in the feed.
      const order = Array.isArray(parsed.order)
        ? parsed.order.filter(ca => hits.has(ca))
        : [...hits.keys()];

      this.log('system', 'Signal store restored from disk', { hits: hits.size });
      return { hits, order };
    } catch (e) {
      this.log('error', 'Signal store load failed, starting empty', { error: e.message });
      return empty;
    }
  }

  /** Queue a debounced save. Safe to call on every single mention. */
  save(hitsMap, order) {
    this._pending = { hitsMap, order };
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      const pending = this._pending;
      this._pending = null;
      if (pending) this._writeNow(pending.hitsMap, pending.order);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Force an immediate synchronous write (used on shutdown). */
  flush(hitsMap, order) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._pending = null;
    this._writeNow(hitsMap, order);
  }

  _writeNow(hitsMap, order) {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const keptOrder = order.slice(0, MAX_PERSISTED);
      const hits = keptOrder.map(ca => hitsMap.get(ca)).filter(Boolean);

      const payload = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        order: keptOrder,
        hits,
      });

      // Atomic: write to tmp, then rename over the real file. rename() is
      // atomic on the same filesystem, so readers never see a partial file.
      writeFileSync(this.tmpPath, payload, 'utf8');
      renameSync(this.tmpPath, this.filePath);
    } catch (e) {
      this.log('error', 'Signal store save failed', { error: e.message });
      try { if (existsSync(this.tmpPath)) unlinkSync(this.tmpPath); } catch (_) {}
    }
  }
}
