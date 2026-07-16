/* ════════════════════════════════════════
   SHARED CSV PARSING UTILITIES
   Used by both onboarding.js and dashboard.js. Load this script BEFORE
   either of those in the page's <script> tags. Previously each page carried
   its own copy of this logic and the copies drifted (see parseDate history
   below) - one copy, one behaviour, going forward.
════════════════════════════════════════ */

function parseDate(str) {
  // ISO: YYYY-MM-DD (optionally with a time suffix) - unambiguous, matched
  // explicitly so it never falls through to the generic parse below.
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}`);
    if (!isNaN(d.getTime())) return d;
  }

  // DD/MM/YYYY or DD-MM-YYYY - our CSV data's actual format. Matched
  // explicitly and rebuilt as an unambiguous YYYY-MM-DD string before ever
  // touching Date(). Previously this function tried `new Date(str)` first,
  // which silently reads "02/01/2025" as US MM/DD (Feb 1st) - so every day
  // <=12 got its day/month swapped. See debtshield-v2_variance-inflation-issue.md.
  const dmy = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`);
    if (!isNaN(d.getTime())) return d;
  }

  // No MM/DD fallback: our data is DD/MM only. A generic Date(str) call here
  // would reintroduce the exact ambiguity this rewrite removes, for anything
  // that isn't already covered above.
  return null;
}

function splitCSVLine(line) {
  // Handle quoted fields that may contain commas; strip Windows carriage returns
  const result = []; let current = ''; let inQuotes = false;
  for (const ch of line) {
    if (ch === '\r') continue; // skip carriage returns from Windows exports
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  const m = arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  return Math.round(m * 100) / 100;
}

function variance(arr, mu) {
  // sample variance - NOT rounded, passed to backend as-is for precision.
  // null (not 0!) when there isn't enough data to estimate it. The backend
  // treats null as "no CSV-derived variance" and falls back to its own
  // heuristic; a literal 0 would be treated as a real (zero) variance and
  // used directly, making the simulation deterministic and snapping the
  // score to a false-certainty 0 or 100 for anyone with a 1-month CSV.
  if (arr.length < 2) return null;
  return arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1);
}

function filterOneOffTransactions(rows) {
  // a large transaction only counts as a one-off if nothing else in the
  // file looks like it. if a similar-sized transaction (same sign, within
  // RECUR_TOLERANCE) shows up in enough other months, it's recurring
  // instead - salary shows up close to every month, a quarterly bonus
  // shows up every few months, a real one-off transfer shows up nowhere
  // else. size alone can't tell these apart, recurrence can.
  const LARGE_MULTIPLE  = 3;
  const RECUR_TOLERANCE = 0.20;
  const RECUR_MIN       = 2;

  const excluded = new Set();
  for (const sign of [1, -1]) {
    const txns = rows.filter(r => Math.sign(r.amount) === sign);
    if (txns.length === 0) continue;
    const medTxn = median(txns.map(r => Math.abs(r.amount)));
    const threshold = medTxn * LARGE_MULTIPLE;
    if (threshold === 0) continue;

    for (const row of txns) {
      const amt = Math.abs(row.amount);
      if (amt <= threshold) continue;
      const rowMonth = `${row.date.getFullYear()}-${row.date.getMonth()}`;
      const monthsWithSimilar = new Set();
      for (const other of txns) {
        if (other === row) continue;
        const otherMonth = `${other.date.getFullYear()}-${other.date.getMonth()}`;
        if (otherMonth === rowMonth) continue;
        if (Math.abs(Math.abs(other.amount) - amt) <= RECUR_TOLERANCE * amt) monthsWithSimilar.add(otherMonth);
      }
      if (monthsWithSimilar.size < RECUR_MIN) excluded.add(row);
    }
  }
  return rows.filter(r => !excluded.has(r));
}

function groupByMonth(rows) {
  // Buckets rows into calendar months, summing income and expenses
  // separately. Every month present in `rows` gets an entry, even months
  // with zero income or zero expenses on one side (that zero is itself a
  // real, meaningful data point for the variance calc, not something to
  // silently drop). Expenses returned here are INCLUSIVE of debt payments -
  // the backend strips debt payments out before passing mu_E to the simulator.
  const byMonth = {};
  for (const row of rows) {
    const key = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
    if (!byMonth[key]) byMonth[key] = { income: 0, expenses: 0 };
    if (row.amount > 0) byMonth[key].income   += row.amount;
    else                byMonth[key].expenses += Math.abs(row.amount);
  }
  const monthKeys = Object.keys(byMonth).sort();
  return {
    monthKeys,
    incomeArr:  monthKeys.map(k => byMonth[k].income),
    expenseArr: monthKeys.map(k => byMonth[k].expenses),
  };
}

function pearsonCorrelation(x, y) {
  // rho = cov(x, y) / (sd_x * sd_y), using the same (n-1) sample convention
  // as variance() above (the (n-1) divisors cancel in the ratio, but kept
  // explicit so this stays consistent if sd_x/sd_y are ever surfaced on
  // their own). Needs at least 3 points to mean anything, and either
  // series being perfectly flat (sd = 0) makes correlation undefined.
  const n = x.length;
  if (n < 3 || y.length !== n) return null;

  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;

  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy;
    vx  += dx * dx;
    vy  += dy * dy;
  }
  cov /= (n - 1); vx /= (n - 1); vy /= (n - 1);

  const sdx = Math.sqrt(vx), sdy = Math.sqrt(vy);
  if (sdx === 0 || sdy === 0) return null;
  return cov / (sdx * sdy);
}
