const TOTAL_STEPS = 5;
let currentStep = 0;
let goals = [];   // [{ id, name, amount }], array order = priority (index 0 = highest)
let debts = [];
let savingsAllocPct = 50;
const API_BASE = 'http://localhost:8000';

// CSV-derived financial data (populated after upload)
let csvData = null; // { b0, mu_I, mu_E, var_I, var_E, months }

const DEFAULT_APR = {
  'Mortgage': 6.8, 'Car Loan': 7.1, 'Student Loan': 5.5,
  'Credit Card': 24.6, 'Personal Loan': 12.4, 'Medical': 0.0, 'Other': 10.0,
};
const DEBT_CATEGORIES = [...Object.keys(DEFAULT_APR), 'Custom'];

/* ─── NAVIGATION ─── */
function goTo(step) {
  if (!validate(currentStep)) return;
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const seg = document.getElementById(`seg-${i}`);
    seg.className = 'progress-seg';
    if (i < step) seg.classList.add('done');
    else if (i === step) seg.classList.add('active');
  }
  document.getElementById(`step-${currentStep}`).classList.remove('active');
  currentStep = step;
  document.getElementById(`step-${currentStep}`).classList.add('active');
  if (step === 4) renderSummary();
}

/* ─── VALIDATION ─── */
function validate(step) {
  clearErrors();
  if (step === 0) {
    if (!document.getElementById('name').value.trim()) { showError('err-0'); return false; }
  }
  if (step === 1) {
    if (!csvData) { showError('err-1'); return false; }
  }
  if (step === 2) {
    // Goals are optional: you can't score worse for not having one, since
    // savings_goals never reaches the simulator (display/tracking only).
    // Any goal that WAS started still needs to be complete, though, no
    // half-filled entries silently dropped.
    for (const g of goals) {
      if (!g.name.trim() || g.amount === '' || isNaN(parseFloat(g.amount))) {
        showError('err-2'); return false;
      }
    }
  }
  if (step === 3) {
    for (const d of debts) {
      const monthsOk = d.indefinite || d.months !== '';
      if (!d.category || d.total === '' || d.monthly === '' || d.apr === '' || !monthsOk) {
        showError('err-3'); return false;
      }
    }
    // Heads-up, not a hard stop: if the payment doesn't even cover the
    // interest, the balance grows instead of shrinking at that rate. Uses
    // the same interestOnlyFloor() as the payment hint above, so the two
    // features can't disagree about where that line is.
    const negAm = debts.find(d => {
      const total = parseFloat(d.total), monthly = parseFloat(d.monthly), apr = parseFloat(d.apr);
      const floor = interestOnlyFloor(total, apr);
      return floor !== null && monthly < floor;
    });
    if (negAm) {
      alert(`Heads up: "${negAm.label || negAm.category}"'s monthly payment doesn't cover the interest at ${negAm.apr}% APR, so that balance will grow over time instead of shrinking. You can still continue if that's expected.`);
    }
  }
  return true;
}
function clearErrors() {
  document.querySelectorAll('.error-msg').forEach(el => { el.classList.remove('visible'); el.style.display = 'none'; });
}
function showError(id) {
  const el = document.getElementById(id); el.style.display = 'block'; el.classList.add('visible');
}

/* ─── ALLOCATION SLIDER ─── */
function updateAllocDisplay(val) {
  savingsAllocPct = parseInt(val);
  document.getElementById('alloc-display').textContent = `${val}%`;
  const surplus = csvData ? Math.max(0, (csvData.mu_I - csvData.mu_E) * savingsAllocPct / 100) : 0;
  const surplusStr = csvData ? ` (${fmtMoney(surplus)}/mo)` : '';
  document.getElementById('alloc-sub').textContent =
    `${val}% of your monthly surplus${surplusStr} will be split across your goals by priority.`;
}

/* ─── GOALS — drag-to-reorder ─── */
let dragSrcIndex = null;

function addGoal() {
  goals.push({ id: Date.now(), name: '', amount: '' });
  renderGoals();
}
function removeGoal(id) {
  goals = goals.filter(g => g.id !== id);
  renderGoals();
}
function updateGoal(id, field, val) {
  const g = goals.find(g => g.id === id);
  if (g) g[field] = val;
}

function renderGoals() {
  const list = document.getElementById('goals-list');
  list.innerHTML = '';
  goals.forEach((g, idx) => {
    const div = document.createElement('div');
    div.className = 'goal-drag-item';
    div.draggable = true;
    div.dataset.idx = idx;
    div.innerHTML = `
      <div class="drag-handle" title="Drag to reorder"><span></span><span></span><span></span></div>
      <div class="priority-badge">${idx + 1}</div>
      <div class="goal-fields">
        <div class="goal-finput-wrap">
          <div class="goal-finput-label">Goal name</div>
          <input class="goal-finput" type="text" placeholder="e.g. Emergency Fund" value="${esc(g.name)}"/>
        </div>
        <div class="goal-finput-wrap">
          <div class="goal-finput-label">Target ($)</div>
          <input class="goal-finput" type="number" placeholder="5000" value="${g.amount}" min="0" step="0.01"/>
        </div>
      </div>
      <button class="goal-remove-btn" title="Remove">✕</button>`;

    // Wire events via addEventListener (CSP-safe, no inline handlers)
    const inputs = div.querySelectorAll('input');
    inputs[0].addEventListener('input', function() { updateGoal(g.id, 'name', this.value); });
    inputs[1].addEventListener('input', function() { updateGoal(g.id, 'amount', this.value); });
    div.querySelector('.goal-remove-btn').addEventListener('click', () => removeGoal(g.id));

    div.addEventListener('dragstart', e => {
      dragSrcIndex = idx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => div.classList.add('dragging'), 0);
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('dragging');
      list.querySelectorAll('.goal-drag-item').forEach(el => el.classList.remove('drag-target'));
    });
    div.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.goal-drag-item').forEach(el => el.classList.remove('drag-target'));
      if (dragSrcIndex !== idx) div.classList.add('drag-target');
    });
    div.addEventListener('drop', e => {
      e.preventDefault();
      if (dragSrcIndex === null || dragSrcIndex === idx) return;
      const [moved] = goals.splice(dragSrcIndex, 1);
      goals.splice(idx, 0, moved);
      dragSrcIndex = null;
      renderGoals();
    });

    list.appendChild(div);
  });
  updateAllocDisplay(document.getElementById('alloc-slider').value);
}

/* ─── DEBTS (unchanged from uploaded file) ─── */
let aprManuallyEdited = false;
function addDebt() {
  debts.push({ id: Date.now(), category: '', label: '', total: '', monthly: '', apr: '', aprAutofilled: false, months: '', indefinite: false });
  renderDebts();
}
function removeDebt(id) { debts = debts.filter(d => d.id !== id); renderDebts(); }
function updateDebt(id, field, val) {
  const d = debts.find(d => d.id === id); if (!d) return;
  d[field] = val;
  if (field === 'category' && val !== 'Custom') {
    if (DEFAULT_APR[val] !== undefined) { d.apr = DEFAULT_APR[val]; d.aprAutofilled = true; }
    if (!d.label) d.label = val;
    renderDebts();
  }
}
function overrideApr(id, val) {
  const d = debts.find(d => d.id === id); if (!d) return;
  d.apr = val; d.aprAutofilled = false;
  const hint  = document.getElementById(`apr-hint-${id}`);
  const badge = document.getElementById(`apr-badge-${id}`);
  if (hint)  hint.classList.remove('visible');
  if (badge) badge.style.display = 'none';
}
function toggleIndefinite(id, checked) {
  const d = debts.find(d => d.id === id); if (!d) return;
  d.indefinite = checked; if (checked) d.months = '';
  const mf = document.getElementById(`months-field-${id}`);
  const ic = document.getElementById(`indef-chip-${id}`);
  if (mf) mf.style.display = checked ? 'none' : 'block';
  if (ic) ic.style.display  = checked ? 'block' : 'none';
}
function renderDebts() {
  const list = document.getElementById('debts-list'); list.innerHTML = '';
  debts.forEach(d => {
    const opts = DEBT_CATEGORIES.map(c => `<option value="${c}" ${d.category===c?'selected':''}>${c}</option>`).join('');
    const div = document.createElement('div'); div.className = 'list-item';
    // Field order: category/label, then balance+APR, then term, then
    // monthly payment LAST: the payment guide needs balance/APR/term
    // entered first to compute anything, and the payment field must stay
    // an honest blank the user fills in themselves (see paymentHintText,
    // this is a hint, never a pre-fill, so a declared payment always
    // reflects what's actually in the user's statement).
    div.innerHTML = `
      <div class="grid-2">
        <div><div class="ifl">Category</div>
          <select>
            <option value="" disabled ${!d.category?'selected':''}>Select type…</option>${opts}
          </select></div>
        <div><div class="ifl">Label (optional)</div>
          <input type="text" placeholder="e.g. Honda Civic" value="${esc(d.label)}"/></div>
      </div>
      <div class="grid-2">
        <div><div class="ifl">Balance Remaining ($)</div>
          <input type="number" placeholder="10000" value="${d.total}" min="0" step="0.01"/></div>
        <div>
          <div class="ifl">APR (%)
            <span class="autofill-badge" id="apr-badge-${d.id}" style="display:${d.aprAutofilled?'inline-block':'none'}">auto-filled</span>
          </div>
          <input type="number" placeholder="e.g. 6.8" value="${d.apr}" id="apr-input-${d.id}" min="0" max="100" step="0.1"/>
          <div class="apr-hint ${d.aprAutofilled?'visible':''}" id="apr-hint-${d.id}">
            ↑ Based on avg ${d.category} rate — override if you know yours
          </div>
        </div>
      </div>
      <div class="grid-2" style="margin-bottom:0">
        <div>
          <div class="ifl">Months Remaining</div>
          <div id="months-field-${d.id}" style="display:${d.indefinite?'none':'block'}">
            <input type="number" placeholder="36" value="${d.months}" min="1"/>
          </div>
          <div id="indef-chip-${d.id}" class="indefinite-chip" style="display:${d.indefinite?'block':'none'}">∞ indefinite</div>
          <label class="indefinite-toggle">
            <input type="checkbox" ${d.indefinite?'checked':''}/>
            <span class="toggle-track"></span>
            <span class="toggle-label">No fixed end date</span>
          </label>
        </div>
        <div>
          <div class="ifl">Monthly Payment ($)</div>
          <input type="number" placeholder="250" value="${d.monthly}" min="0" step="0.01"/>
          <div class="apr-hint" id="payment-hint-${d.id}"></div>
        </div>
      </div>
      <div class="item-remove-row"><button class="item-remove">✕ Remove</button></div>`;

    // Wire all events via addEventListener (CSP-safe)
    const selEl = div.querySelector('select');
    selEl.addEventListener('change', function() { updateDebt(d.id, 'category', this.value); updatePaymentHint(d.id); });

    div.querySelector('input[type="text"]').addEventListener('input', function() { updateDebt(d.id, 'label', this.value); });

    // DOM order of number inputs is now: balance, APR, months, monthly payment
    const numInputs = div.querySelectorAll('input[type="number"]');
    numInputs[0].addEventListener('input', function() { updateDebt(d.id, 'total', this.value); updatePaymentHint(d.id); });
    const aprInput = div.querySelector('#apr-input-' + d.id);
    if (aprInput) aprInput.addEventListener('input', function() { overrideApr(d.id, this.value); updatePaymentHint(d.id); });
    if (numInputs[2]) numInputs[2].addEventListener('input', function() { updateDebt(d.id, 'months', this.value); updatePaymentHint(d.id); });
    numInputs[3].addEventListener('input', function() { updateDebt(d.id, 'monthly', this.value); });

    const checkbox = div.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', function() { toggleIndefinite(d.id, this.checked); updatePaymentHint(d.id); });

    div.querySelector('.item-remove').addEventListener('click', () => removeDebt(d.id));

    list.appendChild(div);
    updatePaymentHint(d.id);
  });
}

function updatePaymentHint(id) {
  const d = debts.find(d => d.id === id); if (!d) return;
  const hintEl = document.getElementById(`payment-hint-${id}`);
  if (!hintEl) return;
  const text = paymentHintText(d.total, d.apr, d.months, d.indefinite);
  if (text) { hintEl.textContent = text; hintEl.classList.add('visible'); }
  else      { hintEl.textContent = '';   hintEl.classList.remove('visible'); }
}

/* ─── SUMMARY ─── */
function renderSummary() {
  const name      = document.getElementById('name').value.trim();
  const surplus   = (csvData?.mu_I || 0) - (csvData?.mu_E || 0);
  const totalDebt = debts.reduce((s,d) => s + (parseFloat(d.total)||0), 0);
  const clr = v => v < 0 ? 'var(--red)' : 'var(--green)';
  const b0val  = csvData?.b0  || 0;
  const muIval = csvData?.mu_I || 0;
  const muEval = csvData?.mu_E || 0;

  document.getElementById('summary-grid').innerHTML = `
    <div class="summary-item"><div class="s-label">Name</div><div class="s-value" style="color:var(--text)">${name}</div></div>
    <div class="summary-item"><div class="s-label">Starting Balance</div><div class="s-value" style="color:${clr(b0val)}">${fmtMoney(b0val)}</div></div>
    <div class="summary-item"><div class="s-label">Avg Monthly Income</div><div class="s-value" style="color:${clr(muIval)}">${fmtMoney(muIval)}</div></div>
    <div class="summary-item"><div class="s-label">Avg Monthly Expenses</div><div class="s-value" style="color:${clr(muEval)}">${fmtMoney(muEval)}</div></div>
    <div class="summary-item"><div class="s-label">Monthly Surplus</div>
      <div class="s-value" style="color:${clr(surplus)}">${fmtMoney(surplus)}</div></div>
    <div class="summary-item"><div class="s-label">Savings Allocation</div>
      <div class="s-value" style="color:var(--green)">${savingsAllocPct}% of surplus</div></div>
    ${totalDebt > 0 ? `<div class="summary-item" style="grid-column:1/-1">
      <div class="s-label">Total Debt Entered</div>
      <div class="s-value" style="color:var(--red)">${fmtMoney(totalDebt)}</div></div>` : ''}
  `;

  document.getElementById('goals-pills').innerHTML = goals.length
    ? goals.map((g, i) => `<span class="goal-pill">#${i+1} ${esc(g.name)} — ${fmtMoney(parseFloat(g.amount)||0)}</span>`).join('')
    : `<span class="no-items">No goals added</span>`;

  document.getElementById('debts-pills').innerHTML = debts.length
    ? debts.map(d => {
        const tl = d.indefinite ? '∞' : `${d.months}mo`;
        return `<span class="debt-pill">💳 ${esc(d.label||d.category)} — ${fmtMoney(d.total)} @ ${d.apr}% APR · ${tl}</span>`;
      }).join('')
    : `<span class="no-items">No debts — nice!</span>`;
}

/* ─── SUBMIT ─── */
async function submitData() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Saving...';

  const payload = {
    name:                   document.getElementById('name').value.trim(),
    current_savings:        csvData.b0,
    average_income:         csvData.mu_I,
    average_expenses:       csvData.mu_E,
    var_income:             csvData.var_I,
    var_expenses:           csvData.var_E,
    rho_ie:                 csvData.rho_ie,
    savings_allocation_pct: savingsAllocPct,
    savings_goals: goals.map((g, i) => ({
      name:          g.name,
      target_amount: parseFloat(g.amount),
      priority:      i + 1,
    })),
    debts: debts.map(d => ({
      category:         d.category === 'Custom' ? (d.label||'Other') : d.category,
      label:            d.label || d.category,
      total_amount:     parseFloat(d.total),
      monthly_payment:  parseFloat(d.monthly),
      apr:              parseFloat(d.apr),
      months_remaining: d.indefinite ? null : parseInt(d.months)
    }))
  };

  try {
    const res = await fetch(`${API_BASE}/onboard/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);

    // Notify the extension to save the username and sync the score automatically
    try {
      await chrome.runtime.sendMessage({
        type: 'AUTO_SYNC_PROFILE',
        name: payload.name,
        apiBase: API_BASE,
      });
    } catch (e) {
      // Not fatal: popup can sync manually
    }

    // Show success state then redirect to dashboard
    document.getElementById(`step-${currentStep}`).classList.remove('active');
    document.getElementById('step-success').classList.add('active');
    document.getElementById('success-msg').textContent =
      `Welcome, ${payload.name}! Your shield score has been calculated. Redirecting to dashboard…`;
    setTimeout(() => {
      const params = new URLSearchParams({ name: payload.name });
      window.location.href = `dashboard.html?${params}`;
    }, 2500);
    return; // skip the catch block
  } catch (err) {
    const errEl = document.getElementById('err-4');
    errEl.textContent = `Couldn't reach the server. Is your backend running? (${err.message})`;
    errEl.style.display = 'block'; errEl.classList.add('visible');
    btn.disabled = false; btn.textContent = 'Activate DebtShield 🛡';
  }
}

/* ─── CSV PARSING ─── */
// Wrap in DOMContentLoaded to guarantee DOM is ready before attaching events
document.addEventListener('DOMContentLoaded', function() {
  const dropZone = document.getElementById('drop-zone');

  // Wire CSP-safe event handlers (replaces inline onclick/onchange attributes)
  if (dropZone) {
    dropZone.addEventListener('click', () => document.getElementById('csv-input').click());
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    });
  }

  const csvInput = document.getElementById('csv-input');
  if (csvInput) csvInput.addEventListener('change', function() { if (this.files[0]) handleFileSelect(this.files[0]); });

  const reuploadBtn = document.getElementById('reupload-btn');
  if (reuploadBtn) reuploadBtn.addEventListener('click', resetCSV);

  // Attach button events via JS instead of inline onclick for reliability
  const btnContinue0 = document.querySelector('#step-0 .btn-next');
  if (btnContinue0) btnContinue0.addEventListener('click', () => goTo(1));

  const btnBack1 = document.querySelector('#step-1 .btn-back');
  const btnContinue1 = document.querySelector('#step-1 .btn-next');
  if (btnBack1) btnBack1.addEventListener('click', () => goTo(0));
  if (btnContinue1) btnContinue1.addEventListener('click', () => goTo(2));

  const btnBack2 = document.querySelector('#step-2 .btn-back');
  const btnContinue2 = document.querySelector('#step-2 .btn-next');
  if (btnBack2) btnBack2.addEventListener('click', () => goTo(1));
  if (btnContinue2) btnContinue2.addEventListener('click', () => goTo(3));

  const btnBack3 = document.querySelector('#step-3 .btn-back');
  const btnContinue3 = document.querySelector('#step-3 .btn-next');
  if (btnBack3) btnBack3.addEventListener('click', () => goTo(2));
  if (btnContinue3) btnContinue3.addEventListener('click', () => goTo(4));

  const btnBack4 = document.querySelector('#step-4 .btn-back');
  if (btnBack4) btnBack4.addEventListener('click', () => goTo(3));

  const addGoalBtn = document.querySelector('.add-item-btn:not(.debt-btn)');
  if (addGoalBtn) addGoalBtn.addEventListener('click', addGoal);

  const addDebtBtn = document.querySelector('.add-item-btn.debt-btn');
  if (addDebtBtn) addDebtBtn.addEventListener('click', addDebt);

  const allocSlider = document.getElementById('alloc-slider');
  if (allocSlider) allocSlider.addEventListener('input', function() { updateAllocDisplay(this.value); });

  const submitBtn = document.getElementById('submit-btn');
  if (submitBtn) submitBtn.addEventListener('click', submitData);
});

function handleFileSelect(file) {
  if (!file || !file.name.endsWith('.csv')) {
    alert('Please upload a .csv file.'); return;
  }
  const reader = new FileReader();
  reader.onload = e => parseCSV(e.target.result, file.name);
  reader.readAsText(file);
}

function parseCSV(text, filename) {
  const lines  = text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());

  const amountIdx    = header.findIndex(h => h === 'amount');
  const balanceIdx   = header.findIndex(h => h === 'balance');
  const dateIdx      = header.findIndex(h => h === 'date');
  const recipientIdx = header.findIndex(h => h === 'recipient');

  if (amountIdx === -1 || balanceIdx === -1 || dateIdx === -1) {
    alert('CSV must have Date, Amount, and Balance columns.'); return;
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = splitCSVLine(line);
    const maxIdx = Math.max(amountIdx, balanceIdx, dateIdx);
    if (cols.length < maxIdx + 1) continue;

    const amount    = parseFloat(cols[amountIdx]);
    const balance   = parseFloat(cols[balanceIdx]);
    const dateStr   = cols[dateIdx].trim().replace(/"/g, '');
    const recipient = recipientIdx >= 0 ? cols[recipientIdx].trim().replace(/"/g, '') : '';

    if (isNaN(amount) || isNaN(balance) || !dateStr) continue;

    const date = parseDate(dateStr);
    if (!date || isNaN(date.getTime())) continue;

    rows.push({ date, amount, balance, recipient });
  }

  if (rows.length === 0) {
    alert('No valid rows found. Check the CSV has Date, Amount and Balance columns in a recognised format (YYYY-MM-DD or DD/MM/YYYY).'); return;
  }

  // Sort chronologically oldest → newest
  rows.sort((a, b) => a.date - b.date);

  // B0 = most recent account balance (the current cash position)
  const b0 = rows.length ? rows[rows.length - 1].balance : 0;

  const filteredRows = filterOneOffTransactions(rows);
  const outlierCount = rows.length - filteredRows.length;

  // Group by calendar month to compute per-month income and expenses.
  // Expenses here are INCLUSIVE of debt payments: the backend strips
  // debt payments out before passing mu_E to the simulator.
  const { monthKeys, incomeArr, expenseArr } = groupByMonth(filteredRows);
  const numMonths = monthKeys.length;

  const mu_I  = mean(incomeArr);
  const mu_E  = mean(expenseArr);
  const var_I = variance(incomeArr, mu_I);
  const var_E = variance(expenseArr, mu_E);
  // Note: var_E is the variance of total monthly outgoings including debt payments.
  // Subtracting a fixed constant (debt payments) from mu_E in the backend does NOT
  // change the variance, so var_E is passed through to the simulator unchanged.
  const rho_ie = pearsonCorrelation(incomeArr, expenseArr);

  // Round display/storage values to 2dp; keep raw variances for scoring precision
  const b0r   = Math.round(b0   * 100) / 100;
  const mu_Ir = Math.round(mu_I * 100) / 100;
  const mu_Er = Math.round(mu_E * 100) / 100;
  csvData = { b0: b0r, mu_I: mu_Ir, mu_E: mu_Er, var_I, var_E, rho_ie, months: numMonths };

  // ── Render preview ──
  document.getElementById('csv-filename').textContent    = `${filename} — ${rows.length} transactions`;
  document.getElementById('csv-b0').textContent          = fmtMoney(b0);
  document.getElementById('csv-months').textContent      = numMonths;
  document.getElementById('csv-income').textContent      = fmtMoney(mu_I);
  document.getElementById('csv-expenses').textContent    = fmtMoney(mu_E);
  document.getElementById('csv-income-sd').textContent   = fmtMoney(Math.sqrt(var_I));
  document.getElementById('csv-expense-sd').textContent  = fmtMoney(Math.sqrt(var_E));

  const noteEl = document.getElementById('csv-note');
  if (numMonths < 3) {
    noteEl.innerHTML = '⚠ Less than 3 months of data — estimates may be less reliable.';
    noteEl.style.color = 'var(--yellow)';
  } else if (outlierCount > 0) {
    noteEl.innerHTML = `Based on ${numMonths} full months of transactions. ${outlierCount} unusually large one-off transaction${outlierCount === 1 ? '' : 's'} excluded from the averages.`;
    noteEl.style.color = 'var(--text-muted)';
  } else {
    noteEl.innerHTML = `Based on ${numMonths} full months of transactions.`;
    noteEl.style.color = 'var(--text-muted)';
  }

  // ── Recent transactions preview (last 5) ──
  const recentEl = document.getElementById('csv-recent');
  if (recentEl) {
    const recent = rows.slice(-5).reverse();
    recentEl.innerHTML = recent.map(r => `
      <div class="csv-txn">
        <span class="csv-txn-date">${r.date.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</span>
        <span class="csv-txn-name">${esc(r.recipient || '—')}</span>
        <span class="csv-txn-amt" style="color:${r.amount>0?'var(--green)':'var(--red)'}">
          ${r.amount>0?'+':''}${fmtMoney(r.amount)}
        </span>
      </div>`).join('');
  }

  document.getElementById('csv-preview').classList.add('visible');
  document.getElementById('drop-zone').style.display = 'none';
  // Update allocation hint now we have real surplus data
  updateAllocDisplay(document.getElementById('alloc-slider').value);
}

/* ─── HELPERS ─── */
// parseDate, splitCSVLine, median, mean, variance, filterOneOffTransactions,
// groupByMonth, pearsonCorrelation now live in csv-utils.js (loaded before
// this file in onboarding.html), shared with dashboard.js so the two
// pipelines can't drift apart again.
function resetCSV() {
  csvData = null;
  document.getElementById('csv-preview').classList.remove('visible');
  document.getElementById('csv-input').value = '';
  document.getElementById('drop-zone').style.display = '';
}

function esc(str) { return String(str||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// Onboarding runs before any settings exist (it's what creates them), so there's
// no currency preference to read yet - defaults to GBP, matching background.js.
function fmtMoney(n) { return '£' + parseFloat(n||0).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2}); }