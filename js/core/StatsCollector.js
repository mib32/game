/**
 * StatsCollector — Prometheus-style labelled counter registry.
 *
 * Usage:
 *   sim.stats.inc('requests_total', { type: 'api' });
 *   sim.stats.get('requests_outcome', { type: 'sql', status: 'success' });
 *   sim.stats.sum('requests_outcome', { status: 'success' });
 */
export class StatsCollector {
  constructor() {
    /** @type {Record<string, number>} */
    this._counters = {};
  }

  /** Increment a labelled counter */
  inc(name, labels = {}) {
    const key = this._key(name, labels);
    this._counters[key] = (this._counters[key] || 0) + 1;
  }

  /** Read a labelled counter */
  get(name, labels = {}) {
    return this._counters[this._key(name, labels)] || 0;
  }

  /**
   * Sum all counters matching `name` across any values for labels
   * not specified in `fixedLabels`.
   * Example: sum('requests_outcome', { status: 'success' })
   *   → sums api+sql success counters.
   */
  sum(name, fixedLabels = {}) {
    const prefix = name + ':';
    const fixed = Object.entries(fixedLabels).sort((a, b) => a[0].localeCompare(b[0]));
    let total = 0;
    for (const [key, val] of Object.entries(this._counters)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest === '') { total += val; continue; }
      const pairs = rest.split(',').map(p => p.split('='));
      if (fixed.every(([fk, fv]) => pairs.some(([pk, pv]) => pk === fk && pv === fv))) {
        total += val;
      }
    }
    return total;
  }

  // ── Convenience getters (used by UI) ──────────────────────

  get totalApiRequests() {
    return this.get('requests_total', { type: 'api' });
  }

  get totalDbRequests() {
    return this.get('requests_total', { type: 'sql' });
  }

  get success() {
    return this.get('requests_outcome', { type: 'api', status: 'success' })
         + this.get('requests_outcome', { type: 'sql', status: 'success' });
  }

  get fail() {
    return this.get('requests_outcome', { type: 'api', status: 'error' })
         + this.get('requests_outcome', { type: 'sql', status: 'error' });
  }

  // ── Internal ──────────────────────────────────────────────

  _key(name, labels) {
    const entries = Object.entries(labels)
      .filter(([, v]) => v != null)
      .sort((a, b) => a[0].localeCompare(b[0]));
    return entries.length === 0
      ? name
      : name + ':' + entries.map(([k, v]) => `${k}=${v}`).join(',');
  }
}