/* ════════════════════════════════════════
   CONFIG
════════════════════════════════════════ */
const API_BASE     = 'http://localhost:8000';
const FALLBACK_SCORE = 70;

/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
let goals   = [];   // [{ id, name, target, priority }], sorted by priority asc
let debts   = [];
let profile = { income: 0, expenses: 0, savings: 0, var_income: null, var_expenses: null, rho_ie: null };
let savingsAllocPct = 50;  // % of monthly surplus going to goals

const DEFAULT_APR = {
  'Mortgage': 6.8, 'Car Loan': 7.1, 'Student Loan': 5.5,
  'Credit Card': 24.6, 'Personal Loan': 12.4, 'Medical': 0.0, 'Other': 10.0,
};
let aprManuallyEdited = false;

/* ════════════════════════════════════════
   PRIORITY-WEIGHTED ALLOCATION
   Rank 1 = highest priority.
   Weight for rank r (of N goals) = N - r + 1
   Each goal's monthly allocation = totalSavings * weight[r] / sum(weights)
════════════════════════════════════════ */
function computeGoalAllocations() {
  const surplus      = profile.income - profile.expenses;
  const totalSavings = Math.max(0, surplus * savingsAllocPct / 100);
  const N = goals.length;
  if (N === 0 || totalSavings <= 0) return goals.map(() => ({ monthly: 0, months: null }));

  // goals must be sorted by priority (ascending) before calling this
  const sorted = [...goals].sort((a, b) => a.priority - b.priority);
  const weights = sorted.map((_, i) => N - i);        // rank 1 → weight N, rank N → weight 1
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  return sorted.map((g, i) => {
    const monthly = totalSavings * weights[i] / totalWeight;
    const months  = monthly > 0 ? Math.ceil(g.target / monthly) : null;
    return { id: g.id, monthly, months };
  });
}

/* ════════════════════════════════════════
   NAVIGATION
════════════════════════════════════════ */
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${id}`).classList.add('active');
  document.getElementById(`nav-${id}`).classList.add('active');
}

function showTab(id) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tabpanel-${id}`).classList.add('active');
  document.getElementById(`tab-${id}`).classList.add('active');
}

/* ════════════════════════════════════════
   ALLOCATION SLIDER (goals panel)
════════════════════════════════════════ */
function updateDashAlloc(val) {
  savingsAllocPct = parseInt(val);
  document.getElementById('dash-alloc-pct').textContent = `${val}%`;
  renderGoals();
  // Sync to backend without triggering a full re-render loop
  syncAndRefresh();
}

/* ════════════════════════════════════════
   SHIELD SCORE GAUGE
════════════════════════════════════════ */
function scoreColor(s) {
  if (s >= 80) return { color: '#00e5a0', label: 'Excellent', bg: '#00e5a015', border: '#00e5a040' };
  if (s >= 60) return { color: '#00e5a0', label: 'Good',      bg: '#00e5a015', border: '#00e5a040' };
  if (s >= 40) return { color: '#ffd166', label: 'Fair',      bg: '#ffd16615', border: '#ffd16640' };
  if (s >= 20) return { color: '#ff8c42', label: 'At Risk',   bg: '#ff8c4215', border: '#ff8c4240' };
  return               { color: '#ff4d6d', label: 'Critical', bg: '#ff4d6d15', border: '#ff4d6d40' };
}

function renderGauge(score) {
  const arcLength = 201;
  const offset    = arcLength - (score / 100) * arcLength;
  const { color, label, bg, border } = scoreColor(score);
  const scoreRounded = Math.round(score * 10) / 10;

  setTimeout(() => {
    document.getElementById('gauge-arc').style.strokeDashoffset = offset;
    document.getElementById('gauge-arc').style.stroke = color;
  }, 100);

  document.getElementById('gauge-text').setAttribute('fill', color);
  document.getElementById('gauge-text').textContent = scoreRounded;
  document.getElementById('score-display').textContent = scoreRounded;
  document.getElementById('score-display').style.color = color;
  document.getElementById('score-band').style.cssText =
    `color:${color}; border-color:${border}; background:${bg}`;
  document.getElementById('score-band-label').textContent = label;

  const descs = {
    'Excellent': 'Outstanding financial health. Your defences are at maximum strength.',
    'Good':      'Your financial defences are solid. Keep reducing high-interest debt and maintaining your savings momentum.',
    'Fair':      'Some areas need attention. Focus on reducing high-APR debt and building your emergency fund.',
    'At Risk':   'Several warning signs detected. Prioritise paying down debt and avoid new credit commitments.',
    'Critical':  'Immediate action needed. Consider speaking with a financial counsellor.',
  };
  document.getElementById('score-desc').textContent = descs[label];
}

async function refreshScore() {
  const recalcEl = document.getElementById('score-recalc');
  recalcEl.classList.add('visible');
  try {
    const res = await fetch(`${apiBase}/score/${encodeURIComponent(userName)}`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    renderGauge(data.shield_score);
  } catch (err) {
    console.warn('Score fetch failed, using fallback.', err);
    renderGauge(FALLBACK_SCORE);
  } finally {
    recalcEl.classList.remove('visible');
  }
}

/* ════════════════════════════════════════
   STATS
════════════════════════════════════════ */
function updateStats() {
  const surplus = profile.income - profile.expenses;

  const surplusEl = document.getElementById('stat-surplus');
  surplusEl.textContent = fmtMoney(surplus);
  surplusEl.style.color = surplus >= 0 ? 'var(--green)' : 'var(--red)';

  const balance   = profile.savings;
  const balanceEl = document.getElementById('stat-balance');
  balanceEl.textContent = fmtMoney(balance);
  balanceEl.style.color = balance >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('stat-goals').textContent = goals.length;
}

/* ════════════════════════════════════════
   GOALS RENDER: draggable, shows ETA
════════════════════════════════════════ */
let goalDragSrcIndex = null;

function renderGoals() {
  const list = document.getElementById('goals-list');
  if (goals.length === 0) {
    list.innerHTML = '<div class="empty-state">No goals yet — add one above</div>'; return;
  }

  // Sort by priority before rendering
  goals.sort((a, b) => a.priority - b.priority);

  const allocs = computeGoalAllocations();  // returns [{id, monthly, months}] sorted by priority

  list.innerHTML = '';
  goals.forEach((g, idx) => {
    const alloc = allocs.find(a => a.id === g.id) || { monthly: 0, months: null };
    const etaText = alloc.months === null
      ? 'no surplus'
      : alloc.months === 1
        ? '1 month'
        : `${alloc.months} months`;
    const etaClass = alloc.months === null ? 'goal-eta unreachable' : 'goal-eta';

    const div = document.createElement('div');
    div.className = 'goal-item-row';
    div.draggable = true;
    div.dataset.idx = idx;
    div.innerHTML = `
      <div class="goal-drag-handle" title="Drag to reorder"><span></span><span></span><span></span></div>
      <div class="goal-priority-badge">${idx + 1}</div>
      <div class="item-icon goal">🎯</div>
      <div class="item-main">
        <div class="item-name">${esc(g.name)}</div>
        <div class="item-meta">${fmtMoney(alloc.monthly)}/mo allocated</div>
      </div>
      <div class="${etaClass}">${etaText}</div>
      <div class="item-amount" style="color:var(--green)">${fmtMoney(g.target)}</div>
      <div class="item-actions">
        <button class="icon-btn goal-edit-btn" title="Edit">✎</button>
        <button class="icon-btn del goal-del-btn" title="Delete">✕</button>
      </div>`;

    div.querySelector('.goal-edit-btn').addEventListener('click', () => openGoalModal(g.id));
    div.querySelector('.goal-del-btn').addEventListener('click',  () => deleteGoal(g.id));

    div.addEventListener('dragstart', e => {
      goalDragSrcIndex = idx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => div.classList.add('dragging'), 0);
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('dragging');
      list.querySelectorAll('.goal-item-row').forEach(el => el.classList.remove('drag-target'));
    });
    div.addEventListener('dragover', e => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.goal-item-row').forEach(el => el.classList.remove('drag-target'));
      if (goalDragSrcIndex !== idx) div.classList.add('drag-target');
    });
    div.addEventListener('drop', e => {
      e.preventDefault();
      if (goalDragSrcIndex === null || goalDragSrcIndex === idx) return;
      // Reorder: splice from src, insert at target, reassign priorities
      const sorted = [...goals].sort((a, b) => a.priority - b.priority);
      const [moved] = sorted.splice(goalDragSrcIndex, 1);
      sorted.splice(idx, 0, moved);
      sorted.forEach((g, i) => { g.priority = i + 1; });
      goals = sorted;
      goalDragSrcIndex = null;
      renderGoals();
      syncAndRefresh();
    });

    list.appendChild(div);
  });
}

/* ════════════════════════════════════════
   DEBTS RENDER (unchanged)
════════════════════════════════════════ */
function renderDebts() {
  const list = document.getElementById('debts-list');
  if (debts.length === 0) {
    list.innerHTML = '<div class="empty-state">No debts recorded — great!</div>'; return;
  }
  list.innerHTML = '';
  debts.forEach(d => {
    const timeline = d.indefinite ? '∞ indefinite' : `${d.months}mo remaining`;
    const div = document.createElement('div');
    div.className = 'item-row';
    div.innerHTML = `
      <div class="item-icon debt">💳</div>
      <div class="item-main">
        <div class="item-name">${esc(d.label || d.category)}</div>
        <div class="item-meta">${d.apr}% APR · ${timeline}</div>
      </div>
      <div class="item-amount" style="color:var(--red)">${fmtMoney(d.total)}</div>
      <div class="item-actions">
        <button class="icon-btn debt-edit-btn" title="Edit">✎</button>
        <button class="icon-btn del debt-del-btn" title="Delete">✕</button>
      </div>`;
    div.querySelector('.debt-edit-btn').addEventListener('click', () => openDebtModal(d.id));
    div.querySelector('.debt-del-btn').addEventListener('click',  () => deleteDebt(d.id));

    list.appendChild(div);
  });
}

/* ════════════════════════════════════════
   GOAL CRUD: no timeframe
════════════════════════════════════════ */
function openGoalModal(id) {
  document.getElementById('goal-edit-id').value = id || '';
  document.getElementById('goal-modal-title').textContent = id ? 'Edit Savings Goal' : 'Add Savings Goal';
  if (id) {
    const g = goals.find(g => g.id === id);
    document.getElementById('gm-name').value   = g.name;
    document.getElementById('gm-amount').value = g.target;
  } else {
    document.getElementById('gm-name').value   = '';
    document.getElementById('gm-amount').value = '';
  }
  openModal('goal-modal-overlay');
}

function saveGoal() {
  const name   = document.getElementById('gm-name').value.trim();
  const amount = parseFloat(document.getElementById('gm-amount').value);
  if (!name || isNaN(amount)) { alert('Please fill in name and target amount.'); return; }

  const editId = document.getElementById('goal-edit-id').value;
  if (editId) {
    const g = goals.find(g => g.id === +editId);
    if (g) { g.name = name; g.target = amount; }
  } else {
    // New goal gets lowest priority (appended to end)
    const maxPriority = goals.length > 0 ? Math.max(...goals.map(g => g.priority)) : 0;
    goals.push({ id: Date.now(), name, target: amount, priority: maxPriority + 1 });
  }
  closeModal('goal-modal-overlay');
  renderGoals(); updateStats();
  syncAndRefresh();
}

function deleteGoal(id) {
  goals = goals.filter(g => g.id !== id);
  // Re-normalise priorities to be contiguous 1..N
  goals.sort((a, b) => a.priority - b.priority).forEach((g, i) => { g.priority = i + 1; });
  renderGoals(); updateStats();
  syncAndRefresh();
}

/* ════════════════════════════════════════
   DEBT CRUD (unchanged)
════════════════════════════════════════ */
function openDebtModal(id) {
  aprManuallyEdited = false;
  document.getElementById('debt-edit-id').value = id || '';
  document.getElementById('debt-modal-title').textContent = id ? 'Edit Debt' : 'Add Debt';
  document.getElementById('dm-apr-hint').style.display = 'none';

  if (id) {
    const d = debts.find(d => d.id === id);
    document.getElementById('dm-category').value     = d.category;
    document.getElementById('dm-label').value        = d.label || '';
    document.getElementById('dm-total').value        = d.total;
    document.getElementById('dm-monthly').value      = d.monthly;
    document.getElementById('dm-apr').value          = d.apr;
    document.getElementById('dm-indefinite').checked = d.indefinite;
    document.getElementById('dm-months').value       = d.months || '';
    toggleDebtIndefinite(d.indefinite);
  } else {
    ['dm-category','dm-label','dm-total','dm-monthly','dm-apr','dm-months'].forEach(fid => {
      const el = document.getElementById(fid);
      if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = '';
    });
    document.getElementById('dm-indefinite').checked = false;
    toggleDebtIndefinite(false);
  }
  // toggleDebtIndefinite() above already calls updateDebtPaymentHint(), so
  // the hint reflects whatever values (edit-mode prefill, or the blank
  // reset) were just set into the fields, no extra call needed here.
  openModal('debt-modal-overlay');
}

function debtCategoryChanged() {
  const cat = document.getElementById('dm-category').value;
  if (cat !== 'Custom' && DEFAULT_APR[cat] !== undefined && !aprManuallyEdited) {
    document.getElementById('dm-apr').value = DEFAULT_APR[cat];
    document.getElementById('dm-apr-hint').style.display = 'block';
  }
  if (!document.getElementById('dm-label').value) {
    document.getElementById('dm-label').value = cat !== 'Custom' ? cat : '';
  }
  updateDebtPaymentHint();
}

function toggleDebtIndefinite(forceVal) {
  const checked = forceVal !== undefined ? forceVal : document.getElementById('dm-indefinite').checked;
  document.getElementById('dm-months').style.display     = checked ? 'none'  : 'block';
  document.getElementById('dm-indef-chip').style.display = checked ? 'block' : 'none';
  if (forceVal !== undefined) document.getElementById('dm-indefinite').checked = forceVal;
  updateDebtPaymentHint();
}

function updateDebtPaymentHint() {
  const hintEl = document.getElementById('dm-payment-hint');
  if (!hintEl) return;
  const balance    = document.getElementById('dm-total').value;
  const apr        = document.getElementById('dm-apr').value;
  const months     = document.getElementById('dm-months').value;
  const indefinite = document.getElementById('dm-indefinite').checked;
  const text = paymentHintText(balance, apr, months, indefinite);
  if (text) { hintEl.textContent = text; hintEl.style.display = 'block'; }
  else      { hintEl.textContent = '';   hintEl.style.display = 'none'; }
}

function saveDebt() {
  const category  = document.getElementById('dm-category').value;
  const label     = document.getElementById('dm-label').value.trim();
  const total     = parseFloat(document.getElementById('dm-total').value);
  const monthly   = parseFloat(document.getElementById('dm-monthly').value);
  const apr       = parseFloat(document.getElementById('dm-apr').value);
  const indefinite = document.getElementById('dm-indefinite').checked;
  const months    = indefinite ? null : parseInt(document.getElementById('dm-months').value);

  if (!category || isNaN(total) || isNaN(monthly) || isNaN(apr) || (!indefinite && isNaN(months))) {
    alert('Please fill in all fields.'); return;
  }

  // Heads-up, not a hard stop: if the payment doesn't even cover the
  // interest, the balance grows instead of shrinking at that rate. Uses the
  // same interestOnlyFloor() as the payment hint above the field, so the
  // two features can't disagree about where that line is.
  const floor = interestOnlyFloor(total, apr);
  if (floor !== null && monthly < floor) {
    alert(`Heads up: this monthly payment doesn't cover the interest at ${apr}% APR, so the balance will grow over time instead of shrinking. You can still save if that's expected.`);
  }

  const editId = document.getElementById('debt-edit-id').value;
  if (editId) {
    const d = debts.find(d => d.id === +editId);
    if (d) Object.assign(d, { category, label: label||category, total, monthly, apr, indefinite, months });
  } else {
    debts.push({ id: Date.now(), category, label: label||category, total, monthly, apr, indefinite, months });
  }
  closeModal('debt-modal-overlay');
  renderDebts(); updateStats();
  syncAndRefresh();
}

function deleteDebt(id) {
  debts = debts.filter(d => d.id !== id);
  renderDebts(); updateStats();
  syncAndRefresh();
}

/* ════════════════════════════════════════
   PROFILE EDIT (unchanged)
════════════════════════════════════════ */
function populateProfileForm() {
  document.getElementById('prof-income').value   = profile.income   || '';
  document.getElementById('prof-expenses').value = profile.expenses || '';
  document.getElementById('prof-savings').value  = profile.savings  || '';
}

function saveProfile() {
  const income   = parseFloat(document.getElementById('prof-income').value);
  const expenses = parseFloat(document.getElementById('prof-expenses').value);
  const savings  = parseFloat(document.getElementById('prof-savings').value);

  if ([income, expenses, savings].some(isNaN)) {
    alert('Please fill in all profile fields.'); return;
  }

  // only drop the CSV-derived volatility (and correlation, same reasoning)
  // if income or expenses actually changed. a savings-only edit
  // shouldn't invalidate it
  const meansChanged = income !== profile.income || expenses !== profile.expenses;
  profile = {
    income, expenses, savings,
    var_income:   meansChanged ? null : profile.var_income,
    var_expenses: meansChanged ? null : profile.var_expenses,
    rho_ie:       meansChanged ? null : profile.rho_ie,
  };
  updateStats();
  renderGoals(); // re-compute ETAs with new surplus
  syncAndRefresh();

  const msg = document.getElementById('profile-saved-msg');
  msg.classList.add('visible');
  setTimeout(() => msg.classList.remove('visible'), 3000);
}

/* ════════════════════════════════════════
   SYNC + REFRESH
════════════════════════════════════════ */
async function syncAndRefresh() {
  const payload = {
    name:                   userName,
    current_savings:        profile.savings,
    average_income:         profile.income,
    average_expenses:       profile.expenses,
    var_income:             profile.var_income,
    var_expenses:           profile.var_expenses,
    rho_ie:                 profile.rho_ie,
    savings_allocation_pct: savingsAllocPct,
    savings_goals: goals.map(g => ({
      name:          g.name,
      target_amount: g.target,
      priority:      g.priority,
    })),
    debts: debts.map(d => ({
      category:         d.category === 'Custom' ? (d.label || 'Other') : d.category,
      label:            d.label || d.category,
      total_amount:     d.total,
      monthly_payment:  d.monthly,
      apr:              d.apr,
      months_remaining: d.indefinite ? null : d.months,
    })),
  };

  try {
    await fetch(`${apiBase}/onboard/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('Sync to backend failed:', err);
  }

  await refreshScore();
}

/* ════════════════════════════════════════
   PROFILE CSV RE-UPLOAD (unchanged from uploaded file)
════════════════════════════════════════ */
let pendingProfileCSV = null;

// prof-drop wired in DOMContentLoaded below

function handleProfileCSV(file) {
  if (!file || !file.name.endsWith('.csv')) { alert('Please upload a .csv file.'); return; }
  const reader = new FileReader();
  reader.onload = e => parseProfileCSV(e.target.result);
  reader.readAsText(file);
}

function parseProfileCSV(text) {
  const lines  = text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const amountIdx  = header.findIndex(h => h === 'amount');
  const balanceIdx = header.findIndex(h => h === 'balance');
  const dateIdx    = header.findIndex(h => h === 'date');
  if (amountIdx === -1 || balanceIdx === -1 || dateIdx === -1) {
    alert('CSV must have Date, Amount, and Balance columns.'); return;
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    const cols = splitCSVLine(line);
    if (cols.length < Math.max(amountIdx, balanceIdx, dateIdx) + 1) continue;
    const amount  = parseFloat(cols[amountIdx]);
    const balance = parseFloat(cols[balanceIdx]);
    const dateStr = cols[dateIdx].trim().replace(/"/g, '');
    if (isNaN(amount) || isNaN(balance) || !dateStr) continue;
    const date = parseDate(dateStr);
    if (!date || isNaN(date.getTime())) continue;
    rows.push({ date, amount, balance });
  }
  if (rows.length === 0) { alert('No valid rows found in CSV.'); return; }
  rows.sort((a, b) => a.date - b.date);
  const b0 = Math.round(rows[rows.length - 1].balance * 100) / 100;

  const filteredRows = filterOneOffTransactions(rows);

  const { monthKeys, incomeArr, expenseArr } = groupByMonth(filteredRows);

  const mu_I   = mean(incomeArr);
  const mu_E   = mean(expenseArr);
  const var_I  = variance(incomeArr, mu_I);
  const var_E  = variance(expenseArr, mu_E);
  const rho_ie = pearsonCorrelation(incomeArr, expenseArr);
  pendingProfileCSV = { b0, mu_I, mu_E, var_I, var_E, rho_ie, months: monthKeys.length };
  document.getElementById('prof-csv-b0').textContent       = fmtMoney(b0);
  document.getElementById('prof-csv-income').textContent   = fmtMoney(mu_I);
  document.getElementById('prof-csv-expenses').textContent = fmtMoney(mu_E);
  document.getElementById('prof-csv-months').textContent   = monthKeys.length;
  document.getElementById('prof-csv-result').classList.add('visible');
}

// median, filterOneOffTransactions, splitCSVLine, parseDate, mean, variance,
// groupByMonth, pearsonCorrelation now live in csv-utils.js (loaded before
// this file in dashboard.html), shared with onboarding.js so the two
// pipelines can't drift apart again.

function applyProfileCSV() {
  if (!pendingProfileCSV) return;
  const csv = pendingProfileCSV;
  profile.savings      = csv.b0;
  profile.income       = csv.mu_I;
  profile.expenses     = csv.mu_E;
  profile.var_income   = csv.var_I;
  profile.var_expenses = csv.var_E;
  profile.rho_ie       = csv.rho_ie;
  document.getElementById('prof-savings').value  = csv.b0;
  document.getElementById('prof-income').value   = csv.mu_I;
  document.getElementById('prof-expenses').value = csv.mu_E;
  pendingProfileCSV = null;
  document.getElementById('prof-csv-result').classList.remove('visible');
  document.getElementById('prof-csv-input').value = '';
  updateStats();
  renderGoals();
  syncAndRefresh();
  const msg = document.getElementById('profile-saved-msg');
  msg.classList.add('visible');
  setTimeout(() => msg.classList.remove('visible'), 3000);
}

/* ════════════════════════════════════════
   MODAL HELPERS
════════════════════════════════════════ */
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
// modal overlays wired in DOMContentLoaded below

/* ════════════════════════════════════════
   LEARN CARDS
════════════════════════════════════════ */
const TERMS = [
  { word:'APR', category:'credit', cat_label:'Credit', teaser:'The annual cost of borrowing money, expressed as a percentage.', definition:'The rate at which someone who borrows money is charged, calculated over a period of twelve months.' },
  { word:'Credit', category:'credit', cat_label:'Credit', teaser:'A method of paying for goods and services.', definition:'A method of paying for goods or services at a later time, usually paying interest as well as the original money.' },
  { word:'Minimum Payment', category:'credit', cat_label:'Credit', teaser:'The smallest amount you must pay on a debt each month.', definition:'The lowest amount a credit card provider allows you to pay monthly to keep your account in good standing and avoid late fees' },
  { word:'Default', category:'debt', cat_label:'Debt', teaser:'Fail to pay back an agreed amount.', definition:'To fail to do something, such as pay a debt, that you legally have to do.' },
  { word:'Loan', category:'debt', cat_label:'Debt', teaser:'Borrowed Assets', definition:'An amount of money that is borrowed, often from a bank, and has to be paid back, usually together with an extra amount of money that you have to pay as a charge for borrowing.' },
  { word:'Overdraft', category:'debt', cat_label:'Debt', teaser:'Temporary borrowing limits.', definition:'An amount of money that a customer with a bank account is temporarily allowed to owe to the bank, or the agreement that allows this.' },
  { word:'Interest', category:'savings', cat_label:'Savings', teaser:'Money paid to account for the time value of money.', definition:'Money that is paid by a bank or other financial organization for keeping your money in an account, or charged for borrowing money.' },
  { word:'Compound Interest', category:'savings', cat_label:'Savings', teaser:'The effects of interest building over time.', definition:'Interest that is calculated on both the amount of money invested or borrowed and on the interest that has been added to it.' },
  { word:'Savings Account', category:'savings', cat_label:'Savings', teaser:'A certain type of bank account.', definition:'A bank account where you keep money that you do not need to spend immediately and that usually earns interest.' },
  { word:'Inflation', category:'general', cat_label:'General', teaser:'Increase in prices over time.', definition:'An increase in prices over time, causing a reduction in the value of money.' },
  { word:'Tax', category:'general', cat_label:'General', teaser:'Money paid to government based on income / purchases.', definition:'An amount of money paid to the government that is based on your income or the cost of goods or services you have bought.' },
  { word:'Mortgage', category:'general', cat_label:'General', teaser:'Type of loan used to finance property.', definition:'An agreement that allows you to borrow money from a bank or similar organization, especially in order to buy a house, or the amount of money itself.' },
];

function renderLearn() {
  const grid = document.getElementById('learn-grid');
  grid.innerHTML = '';
  TERMS.forEach(t => {
    const card = document.createElement('div');
    card.className = `term-card cat-${t.category}`;
    card.innerHTML = `
      <div class="term-front">
        <div class="term-category">${t.cat_label}</div>
        <div class="term-word">${t.word}</div>
        <div class="term-teaser">${t.teaser}</div>
      </div>
      <div class="term-back">
        <div class="term-back-label">${t.cat_label} · ${t.word}</div>
        <div class="term-definition">${t.definition}</div>
      </div>`;
    card.addEventListener('click', () => card.classList.toggle('flipped'));
    grid.appendChild(card);
  });
}

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Currency comes from settings (default '£', set in background.js DEFAULTS and
// changeable from the popup) - the rest of the extension already reads it that
// way, and this used to hardcode '$'/en-US, so the dashboard disagreed with the
// checkout modal on the same purchase.
let currencySymbol = '£';

function fmtMoney(n) {
  return currencySymbol + parseFloat(n||0).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});
}

/* ════════════════════════════════════════
   INIT
════════════════════════════════════════ */
const urlParams = new URLSearchParams(window.location.search);
let userName = urlParams.get('name') || '';
let apiBase  = urlParams.get('api')  || API_BASE;

// If name wasn't in the URL, try reading it from Chrome extension storage
async function resolveIdentity() {
  // Settings are read even when the URL already gave us a name, since the
  // currency lives there and isn't passed in the URL.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const data = await chrome.storage.local.get('ds_settings');
      const s = data['ds_settings'] || {};
      if (s.currency) currencySymbol = s.currency;
      if (!userName && s.userName) userName = s.userName;
      if (!urlParams.get('api') && s.apiBase) apiBase = s.apiBase;
    }
  } catch (_) {}
  // Update the name chip now that we know who the user is
  if (userName) {
    const chip = document.getElementById('user-name-chip');
    const avatar = document.getElementById('user-avatar');
    if (chip)   chip.textContent   = userName;
    if (avatar) avatar.textContent = userName.charAt(0).toUpperCase();
  }
}

async function init() {
  await resolveIdentity();
  try {
    const res = await fetch(`${apiBase}/user/${encodeURIComponent(userName)}`);
    if (res.ok) {
      const data = await res.json();
      profile = {
        income:       data.average_income    || 0,
        expenses:     data.average_expenses  || 0,
        savings:      data.current_savings   || 0,
        var_income:   data.var_income  ?? null,
        var_expenses: data.var_expenses ?? null,
        rho_ie:       data.rho_ie ?? null,
      };
      savingsAllocPct = data.savings_allocation_pct ?? 50;

      goals = (data.savings_goals || []).map((g, i) => ({
        id:       i + 1,
        name:     g.name,
        target:   g.target_amount,
        priority: g.priority ?? (i + 1),
      }));
      debts = (data.debts || []).map((d, i) => ({
        id:         i + 1,
        category:   d.category,
        label:      d.label,
        total:      d.total_amount,
        monthly:    d.monthly_payment,
        apr:        d.apr,
        indefinite: d.months_remaining === null,
        months:     d.months_remaining,
      }));
    }
  } catch (err) {
    console.warn('Could not load user data from backend:', err);
  }

  // Sync allocation slider to loaded value
  document.getElementById('dash-alloc-slider').value = savingsAllocPct;
  document.getElementById('dash-alloc-pct').textContent = `${savingsAllocPct}%`;

  populateProfileForm();
  renderGoals();
  renderDebts();
  updateStats();
  renderLearn();
  await refreshScore();
}

/* ════════════════════════════════════════
   DOM WIRING + INIT: all DOM access here
════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  // ── userName chip (updated after identity resolves in init) ──
  document.getElementById('user-name-chip').textContent = userName || '…';
  document.getElementById('user-avatar').textContent    = userName ? userName.charAt(0).toUpperCase() : '?';

  // ── Modal overlay backdrop close ─────────────────────────
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // ── Profile CSV drop zone ─────────────────────────────────
  const pd = document.getElementById('prof-drop');
  if (pd) {
    pd.addEventListener('dragover',  e => { e.preventDefault(); pd.style.borderColor = 'var(--green)'; });
    pd.addEventListener('dragleave', ()  => { pd.style.borderColor = ''; });
    pd.addEventListener('drop', e => {
      e.preventDefault(); pd.style.borderColor = '';
      const file = e.dataTransfer.files[0];
      if (file) handleProfileCSV(file);
    });
  }

  // ── Nav ───────────────────────────────────────────────────
  document.getElementById('nav-dashboard')  ?.addEventListener('click', () => showPage('dashboard'));
  document.getElementById('nav-learn')      ?.addEventListener('click', () => showPage('learn'));
  document.getElementById('nav-onboarding') ?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  });

  // ── Tabs ──────────────────────────────────────────────────
  document.getElementById('tab-goals')  ?.addEventListener('click', () => showTab('goals'));
  document.getElementById('tab-debts')  ?.addEventListener('click', () => showTab('debts'));
  document.getElementById('tab-profile')?.addEventListener('click', () => showTab('profile'));

  // ── Allocation slider ─────────────────────────────────────
  document.getElementById('dash-alloc-slider')?.addEventListener('input', function () {
    updateDashAlloc(this.value);
  });

  // ── Goals ─────────────────────────────────────────────────
  document.getElementById('add-goal-btn')    ?.addEventListener('click', () => openGoalModal());
  document.getElementById('goal-modal-close')?.addEventListener('click', () => closeModal('goal-modal-overlay'));
  document.getElementById('save-goal-btn')   ?.addEventListener('click', saveGoal);

  // ── Debts ─────────────────────────────────────────────────
  document.getElementById('add-debt-btn')    ?.addEventListener('click', () => openDebtModal());
  document.getElementById('debt-modal-close')?.addEventListener('click', () => closeModal('debt-modal-overlay'));
  document.getElementById('save-debt-btn')   ?.addEventListener('click', saveDebt);
  document.getElementById('dm-category')     ?.addEventListener('change', debtCategoryChanged);
  document.getElementById('dm-apr')          ?.addEventListener('input',  () => { aprManuallyEdited = true; updateDebtPaymentHint(); });
  document.getElementById('dm-total')        ?.addEventListener('input',  updateDebtPaymentHint);
  document.getElementById('dm-months')       ?.addEventListener('input',  updateDebtPaymentHint);
  document.getElementById('dm-indefinite')   ?.addEventListener('change', toggleDebtIndefinite);

  // ── Profile ───────────────────────────────────────────────
  document.getElementById('save-profile-btn')?.addEventListener('click', saveProfile);
  document.getElementById('apply-csv-btn')   ?.addEventListener('click', applyProfileCSV);

  const profDropBtn  = document.getElementById('prof-csv-drop-btn');
  const profCsvInput = document.getElementById('prof-csv-input');
  profDropBtn ?.addEventListener('click',  () => profCsvInput?.click());
  profCsvInput?.addEventListener('change', function () {
    if (this.files[0]) handleProfileCSV(this.files[0]);
  });

  // ── Kick off init ─────────────────────────────────────────
  init();
});
