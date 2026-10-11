'use strict';

(() => {
  const EMPLOYEES = {
    richard: {name: 'Richard “Call Me Dick” Darling', kind: 'sales'},
    anastasia: {name: 'Anastasia Ferrari', kind: 'sales'},
    jean_claude: {name: 'Jean-Claude Bērziņš', kind: 'sales'},
    kevin: {name: 'Kevin von Whatever', kind: 'expense'},
    svetlana: {name: 'Svetlana de Monte Carlo', kind: 'manager'}
  };
  const PROJECTS = {A: 'Respectable Relatives', B: 'Drunk University Friends'};
  const $ = (id) => document.getElementById(id);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = (cents) => new Intl.NumberFormat('en-IE', {style:'currency',currency:'EUR',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(cents ?? 0) / 100);
  const percent = (value) => `${Number(value ?? 0).toLocaleString('en-IE', {maximumFractionDigits:2})}%`;
  const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('en-GB', {dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : '—';
  const allocation = (value) => value === 'A' || value === 'B' ? `${value} · ${PROJECTS[value]}` : (value || 'Not decided');
  const statusLabel = (status) => ({pending:'Pending approval',approved:'Approved',awaiting_allocation:'Awaiting allocation',allocated:'Allocated'}[status] || status);
  const isPending = (record) => record.status === 'pending' || record.status === 'awaiting_allocation';
  const manager = () => state?.role === 'svetlana';
  let state = null;
  let activeKind = 'sale';
  let loading = false;
  let pendingActions = 0;
  let stateSignature = '';
  const dirtyDecisions = new Set();

  function showMessage(text, error = false) {
    $('message').textContent = text;
    $('message').classList.toggle('error', error);
    $('message').hidden = !text;
  }

  async function api(body) {
    const response = await fetch('/api/app', {
      method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({error:'The server returned an unreadable response.'}));
    if (!response.ok || result.ok === false || result.error) throw new Error(result.error || 'The action could not be completed.');
    return result;
  }

  async function loadState({initial = false, quiet = false} = {}) {
    if (loading) return;
    if (quiet && (document.visibilityState !== 'visible' || pendingActions || dirtyDecisions.size || document.activeElement?.closest('form'))) return;
    loading = true;
    $('refresh').disabled = true;
    try {
      let response = await fetch('/api/app?action=state', {credentials:'same-origin',cache:'no-store'});
      let result = await response.json();
      if (initial && !result.role) {
        await api({action:'role',role:$('role').value});
        response = await fetch('/api/app?action=state', {credentials:'same-origin',cache:'no-store'});
        result = await response.json();
      }
      if (!response.ok && !('configured' in result)) throw new Error(result.error || 'Unable to retrieve saved records.');
      if (quiet && JSON.stringify(result) === stateSignature) return;
      state = result;
      if (!EMPLOYEES[state.role]) state.role = $('role').value;
      stateSignature = JSON.stringify(state);
      $('role').value = state.role;
      render();
    } catch (error) {
      $('connection-indicator').className = 'connection-indicator bad';
      $('connection-indicator').innerHTML = '<span class="dot"></span> Connection unavailable';
      if (!state) {
        $('dashboard').innerHTML = '<div class="loading-card">Saved records could not be loaded. Refresh after the connection is restored.</div>';
        $('record-list').innerHTML = '<div class="record-empty">Records are unavailable. No financial results are being simulated.</div>';
      }
      if (!quiet) showMessage(error.message, true);
    } finally {
      loading = false;
      $('refresh').disabled = false;
    }
  }

  function metric(label, cents, note, result = false) {
    return `<div class="metric ${result ? 'label-result' : ''}"><p class="metric-label">${escapeHTML(label)}</p><p class="metric-value">${money(cents)}</p><p class="metric-note">${escapeHTML(note)}</p></div>`;
  }

  function render() {
    const role = EMPLOYEES[state.role];
    document.querySelectorAll('.manager-only').forEach((element) => element.hidden = !manager());
    $('role-description').textContent = role.kind === 'manager' ? 'Manager · inspect records and make decisions.' : role.kind === 'sales' ? 'Salesperson · submit sales and follow your own records.' : 'Expense reporter · submit expenses and follow your own records.';
    $('entry-section').hidden = manager();
    $('sale-form').hidden = role.kind !== 'sales';
    $('expense-form').hidden = role.kind !== 'expense';
    $('sale-submitter').textContent = role.name;
    $('entry-subtitle').textContent = role.kind === 'sales' ? 'Sale income begins after manager approval.' : 'Expenses count immediately, including while allocation is pending.';
    $('workspace-eyebrow').textContent = manager() ? 'THE BIG PICTURE' : 'YOUR TRANSACTIONS';
    $('workspace-title').textContent = manager() ? 'Company overview' : 'Your finance workspace';
    $('workspace-subtitle').textContent = manager() ? 'EUR · services delivered and paid · no VAT' : `${role.name} · only your submissions are shown`;
    $('records-title').textContent = manager() ? 'Transaction records' : 'Your transaction records';
    $('records-subtitle').textContent = manager() ? 'Original proposals stay visible alongside final decisions.' : 'Follow saved submissions, decisions and delivery status.';
    $('connection-indicator').className = `connection-indicator ${state.configured ? '' : 'bad'}`;
    $('connection-indicator').innerHTML = `<span class="dot"></span> ${state.configured ? 'Records connected' : 'Setup incomplete'}`;
    const missing = Object.entries(state.integrations || {}).filter(([,ready]) => !ready).map(([key]) => ({supabase:'Supabase source of truth',telegram:'Telegram bot',sheets:'Google Sheets service account',session:'Role access'}[key] || key));
    $('readiness').hidden = !missing.length && !state.error;
    $('readiness').innerHTML = `<strong>Connection setup needs attention</strong>${state.error ? `<p>${escapeHTML(state.error)}</p>` : ''}${missing.length ? `<p>Not connected: ${missing.map(escapeHTML).join(', ')}. Saved decisions remain independent of notification and spreadsheet delivery.</p>` : ''}`;
    document.querySelectorAll('#sale-form button[type=submit],#expense-form button[type=submit],#mapping-form button[type=submit]').forEach((button) => button.disabled = !state.configured);
    renderDashboard();
    if (!manager()) activeKind = role.kind === 'expense' ? 'expense' : 'sale';
    $('sales-tab').hidden = !manager() && role.kind === 'expense';
    $('expenses-tab').hidden = !manager() && role.kind === 'sales';
    renderRecords();
    renderConnections();
    renderResources();
  }

  function renderDashboard() {
    const records = state.transactions || [];
    if (!state.configured) {
      $('dashboard').innerHTML = '<div class="loading-card">The finance desk is ready for its database connection. Connect Supabase to retrieve real saved records and financial results.</div>';
      return;
    }
    if (!manager()) {
      const pending = records.filter(isPending);
      const approved = records.filter((record) => !isPending(record));
      const ownTotal = records.reduce((sum,record) => sum + record.amountCents, 0);
      $('dashboard').innerHTML = `<div class="staff-summary"><div class="metric"><p class="metric-label">Your submissions</p><p class="metric-value">${records.length}</p><p class="metric-note">Only records submitted by you</p></div><div class="metric"><p class="metric-label">Needs a decision</p><p class="metric-value">${pending.length}</p><p class="metric-note">${approved.length} approved or allocated</p></div>${metric('Total submitted',ownTotal,'Includes submissions awaiting a decision')}</div>`;
      return;
    }
    const dashboard = state.dashboard;
    if (!dashboard?.company || !dashboard?.projects) {
      $('dashboard').innerHTML = '<div class="loading-card">The database is connected, but the financial dashboard is unavailable. Refresh records to try again.</div>';
      return;
    }
    const company = dashboard.company;
    const projectCards = ['A','B'].map((id) => {
      const project = dashboard.projects[id];
      return `<article class="project-card project-${id.toLowerCase()}"><div class="project-head"><div><p class="eyebrow">WEDDING PROJECT ${id}</p><h3>${PROJECTS[id]}</h3><p>${id === 'A' ? 'Proud uncles. Emotional aunts. Perfect manners.' : 'Loud speeches. Big dancing. Questionable memories.'}</p></div><span class="project-id">${id}</span></div><div class="project-lines"><div><span>Approved income</span><strong>${money(project.incomeCents)}</strong></div><div><span>Commissions</span><strong>${money(project.commissionCents)}</strong></div><div><span>Allocated expenses</span><strong>${money(project.expensesCents)}</strong></div></div><div class="project-result"><span>Project result</span><strong>${money(project.resultCents)}</strong></div></article>`;
    }).join('');
    const earned = dashboard.earnedCommission || {};
    const commissions = [['richard','RD','Richard','Call Me Dick Darling'],['anastasia','AF','Anastasia','Ferrari'],['jean_claude','JB','Jean-Claude','Bērziņš']].map(([id,initials,first,last]) => `<div class="commission-person"><span class="initials">${initials}</span><div class="commission-person-name">${first}<span>${last}</span></div><strong>${money(earned[id])}</strong></div>`).join('');
    const projectResult = dashboard.projects.A.resultCents + dashboard.projects.B.resultCents;
    $('dashboard').innerHTML = `<div class="metrics-grid">${metric('Approved income',company.incomeCents,'Pending sales are excluded')}${metric('Commission earned',company.commissionCents,'10% of each approved sale')}${metric('Recorded expenses',company.expensesCents,'All paid expenses, including pending')}${metric('Company result',company.resultCents,'Income − commissions − all expenses',true)}</div><div class="project-grid">${projectCards}</div><div class="result-support-grid"><div class="reconciliation-card"><h3>Where the difference goes</h3><p>Reconcile project results to the company result.</p><div class="money-line"><span>Combined project results</span><strong>${money(projectResult)}</strong></div><div class="money-line"><span>Less company overhead</span><strong>${money(company.overheadCents)}</strong></div><div class="money-line"><span>Less expenses awaiting allocation</span><strong>${money(company.awaitingCents)}</strong></div><div class="money-line total"><span>Company result</span><strong>${money(company.resultCents)}</strong></div><p class="reconciliation-note">${dashboard.reconciliationCents === company.resultCents ? '✓ Reconciled: no unexplained difference.' : `Reconciliation difference: ${money(dashboard.reconciliationCents - company.resultCents)}`}</p></div><div class="commissions-card"><h3>Commission earned by salesperson</h3><p>Approved sales only. Payment tracking is not required.</p>${commissions}<div class="money-line total"><span>Total earned</span><strong>${money(company.commissionCents)}</strong></div></div></div><div class="pending-strip"><div><strong>${money(dashboard.pendingSalesCents)}</strong><span>pending sales · ${dashboard.pendingSalesCount} record${dashboard.pendingSalesCount === 1 ? '' : 's'}</span></div><div><strong>${money(company.awaitingCents)}</strong><span>awaiting allocation · ${dashboard.awaitingExpenseCount} record${dashboard.awaitingExpenseCount === 1 ? '' : 's'}</span></div><a href="#records">Review pending decisions ↗</a></div>`;
  }

  function commissionDetails(record, approved) {
    const split = approved ? record.finalSplit : record.proposedSplit;
    if (!split) return '<p class="detail-value">No approved split yet<span>Earned commission €0.00</span></p>';
    return ['Richard','Anastasia','Jean-Claude'].map((name,index) => `<div class="split-row"><span>${name}</span><strong>${percent(split[index])}${approved ? ` · ${money(record.commissionsCents?.[index] || 0)}` : ''}</strong></div>`).join('');
  }

  function deliveryItem(record, channel) {
    const delivery = channel === 'sheets' ? record.sync : record.notification;
    const labels = channel === 'sheets' ? {pending:'Sync pending',processing:'Sync pending',sent:'Sheets synchronized',failed:'Sync failed'} : {pending:'Notification pending',processing:'Notification pending',sent:'Telegram notification sent',failed:'Telegram notification failed',no_recipient:'No Telegram recipient linked'};
    const currentStatus = delivery?.status || 'pending';
    const retry = manager() && ['pending','failed'].includes(currentStatus);
    return `<div class="integration-item ${currentStatus === 'failed' ? 'error' : currentStatus === 'sent' ? 'good' : ''}" ${delivery?.error ? `title="${escapeHTML(delivery.error)}"` : ''}><span aria-hidden="true">${currentStatus === 'sent' ? '✓' : currentStatus === 'failed' ? '!' : '○'}</span><span>${labels[currentStatus] || escapeHTML(currentStatus)}${delivery?.error && currentStatus === 'failed' ? ` · ${escapeHTML(delivery.error)}` : ''}</span>${retry ? `<button class="button button-light" type="button" data-retry="${channel}" data-reference="${escapeHTML(record.reference)}">Retry</button>` : ''}</div>`;
  }

  function recordCard(record) {
    const pending = isPending(record);
    const title = record.kind === 'sale' ? record.customer : record.category;
    const details = record.kind === 'sale'
      ? `<div class="detail-grid"><div class="detail-block"><p class="detail-label">Original proposed commission split</p>${commissionDetails(record,false)}</div><div class="detail-block"><p class="detail-label">${record.finalSplit ? 'Approved commission split' : 'Manager decision pending'}</p>${commissionDetails(record,true)}</div></div>`
      : `<div class="detail-grid"><div class="detail-block"><p class="detail-label">Original proposed allocation</p><p class="detail-value">${escapeHTML(allocation(record.proposedAllocation))}</p></div><div class="detail-block"><p class="detail-label">Final allocation</p><p class="detail-value">${escapeHTML(allocation(record.finalAllocation))}${pending ? '<span>Already included in company expenses.</span>' : ''}</p></div></div>`;
    let decision = '';
    if (manager() && pending) {
      if (record.kind === 'sale') decision = `<form class="decision-panel" data-decision="sale" data-reference="${escapeHTML(record.reference)}"><p class="decision-heading">Review commission split, then approve the sale</p><div class="decision-fields">${['Richard','Anastasia','Jean-Claude'].map((name,index) => `<label>${name} (%)<input name="split${index}" type="number" min="0" max="100" step="0.01" value="${Number(record.proposedSplit[index])}" required></label>`).join('')}<button class="button button-primary" type="submit">Approve sale</button></div><p class="decision-helper">Shares must total 100%. The original proposal is preserved. Sale income and the 10% commission pool enter results together.</p></form>`;
      else decision = `<form class="decision-panel" data-decision="expense" data-reference="${escapeHTML(record.reference)}"><p class="decision-heading">Confirm or correct the expense allocation</p><div class="decision-fields expense-decision"><label>Final allocation<select name="allocation">${['A','B','Company overhead'].map((value) => `<option value="${value}" ${value === record.proposedAllocation ? 'selected' : ''}>${escapeHTML(allocation(value))}</option>`).join('')}</select></label><button class="button button-primary" type="submit">Confirm allocation</button></div><p class="decision-helper">Allocation changes project results. This expense will not be deducted from company result again.</p></form>`;
    }
    return `<article class="record-card ${record.kind}"><div class="record-main"><span class="record-reference">${escapeHTML(record.reference)}</span><div class="record-text"><div class="record-topline"><h3>${escapeHTML(title)}</h3><span class="badge ${pending ? 'pending' : ''}">${statusLabel(record.status)}</span>${record.changed ? '<span class="badge neutral">Proposal changed</span>' : ''}</div><p class="record-description">${escapeHTML(record.description)}</p><p class="record-meta"><span>${escapeHTML(record.submittedBy?.name || 'Unknown submitter')}</span><span>${record.source === 'telegram' ? 'Telegram' : 'Website'} · ${escapeHTML(date(record.submittedAt))}</span>${record.kind === 'sale' ? `<span>Project ${escapeHTML(record.project)} · ${escapeHTML(PROJECTS[record.project])}</span>` : ''}${record.decisionAt ? `<span>Decided ${escapeHTML(date(record.decisionAt))}</span>` : ''}</p></div><div class="record-amount">${money(record.amountCents)}<span>${record.kind === 'sale' ? `Commission pool ${money(pending ? record.proposedCommissionPoolCents : record.commissionPoolCents)}${pending ? ' · not earned' : ''}` : 'Already paid'}</span></div></div><div class="record-details">${details}</div>${decision}<div class="integration-row">${deliveryItem(record,'sheets')}${deliveryItem(record,'telegram')}</div></article>`;
  }

  function renderRecords() {
    const records = state.transactions || [];
    $('sales-count').textContent = records.filter((record) => record.kind === 'sale').length;
    $('expenses-count').textContent = records.filter((record) => record.kind === 'expense').length;
    $('sales-tab').classList.toggle('active',activeKind === 'sale');
    $('expenses-tab').classList.toggle('active',activeKind === 'expense');
    $('sales-tab').setAttribute('aria-selected',String(activeKind === 'sale'));
    $('expenses-tab').setAttribute('aria-selected',String(activeKind === 'expense'));
    const query = $('record-search').value.trim().toLowerCase();
    const filter = $('status-filter').value;
    const shown = records.filter((record) => {
      if (record.kind !== activeKind) return false;
      if (query && ![record.reference,record.description,record.customer,record.category,record.submittedBy?.name].some((value) => String(value || '').toLowerCase().includes(query))) return false;
      if (filter === 'pending') return isPending(record);
      if (filter === 'approved') return !isPending(record);
      if (filter === 'integration') return ['pending','failed'].includes(record.sync?.status) || ['pending','failed'].includes(record.notification?.status);
      return true;
    }).sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    $('record-list').innerHTML = shown.length ? shown.map(recordCard).join('') : `<div class="record-empty">${!state.configured ? 'Connect Supabase to load saved transactions.' : records.some((record) => record.kind === activeKind) ? 'No records match this search and status filter.' : `No ${activeKind === 'sale' ? 'sales' : 'expenses'} submitted ${manager() ? 'yet' : 'by you yet'}.`}</div>`;
  }

  function renderConnections() {
    if (!manager()) return;
    const names = {supabase:'Supabase · source of truth',telegram:'Telegram · submissions & decisions',sheets:'Google Sheets · viewing copy'};
    $('integration-status').innerHTML = Object.entries(names).map(([id,name]) => `<div class="status-line"><span>${name}</span><span class="badge ${state.integrations?.[id] ? '' : 'pending'}">${state.integrations?.[id] ? 'Configured' : 'Not configured'}</span></div>`).join('');
    const accounts = state.setup?.telegramAccounts || [];
    $('mapping-list').innerHTML = accounts.length ? accounts.map((account) => `<div class="mapping-entry"><span class="initials">TG</span><div>${escapeHTML(account.employeeId ? EMPLOYEES[account.employeeId]?.name || account.employeeId : 'Not linked to an employee')}<span>User ${escapeHTML(account.telegramUserId)} · chat ${escapeHTML(account.chatId)}${account.firstName ? ` · ${escapeHTML(account.firstName)}` : ''}</span></div>${account.employeeId ? `<button type="button" class="button button-text" data-unlink="${escapeHTML(account.telegramUserId)}">Unlink</button>` : ''}</div>`).join('') : '<p class="mapping-empty">No accounts recorded. Start the Telegram bot to register a private chat.</p>';
    $('failure-sheets').checked = Boolean(state.setup?.faults?.sheets);
    $('failure-telegram').checked = Boolean(state.setup?.faults?.telegram);
    $('failure-sheets').disabled = !state.configured;
    $('failure-telegram').disabled = !state.configured;
  }

  function renderResources() {
    const links = state.links || {};
    const safeURL = (value) => {
      try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
    };
    $('resource-links').innerHTML = [['telegram','Telegram bot'],['sheets','Google Sheets'],['github','GitHub repository']].map(([key,label]) => {
      const url = safeURL(links[key]);
      return url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : `<span>${label} · not connected</span>`;
    }).join('');
  }

  function validateSplit(split) {
    if (split.some((value) => !Number.isFinite(value) || value < 0 || value > 100) || Math.abs(split.reduce((sum,value) => sum + value,0) - 100) > 0.00001) throw new Error('Each commission share must be between 0% and 100%, and all three shares must total exactly 100%.');
  }

  async function perform(body, element, successText) {
    pendingActions += 1;
    const buttons = element ? [...element.querySelectorAll('button,input,select,textarea')] : [];
    const oldDisabled = buttons.map((button) => button.disabled);
    buttons.forEach((button) => button.disabled = true);
    showMessage('');
    try {
      const result = await api(body);
      if (body.action === 'approveSale' || body.action === 'allocateExpense') dirtyDecisions.delete(body.reference);
      showMessage(typeof successText === 'function' ? successText(result) : successText);
      await loadState();
      return result;
    } catch (error) {
      showMessage(error.message,true);
      return null;
    } finally {
      pendingActions -= 1;
      buttons.forEach((button,index) => { if (button.isConnected) button.disabled = oldDisabled[index]; });
    }
  }

  $('role').addEventListener('change', async (event) => {
    const previousRole = state?.role;
    const selected = event.target.value;
    pendingActions += 1;
    $('role').disabled = true;
    showMessage('');
    try {
      await api({action:'role',role:selected});
      dirtyDecisions.clear();
      document.querySelectorAll('.manager-only').forEach((element) => element.hidden = true);
      $('entry-section').hidden = true;
      $('dashboard').innerHTML = '<div class="loading-card">Loading this employee’s saved records…</div>';
      $('record-list').innerHTML = '<div class="loading-card">Loading records permitted for this role…</div>';
      await loadState();
    }
    catch (error) { if (previousRole) $('role').value = previousRole; showMessage(error.message,true); }
    finally { pendingActions -= 1; $('role').disabled = false; }
  });
  $('refresh').addEventListener('click', () => {showMessage('');dirtyDecisions.clear();loadState();});
  $('sales-tab').addEventListener('click', () => {activeKind='sale';renderRecords();});
  $('expenses-tab').addEventListener('click', () => {activeKind='expense';renderRecords();});
  $('record-search').addEventListener('input',renderRecords);
  $('status-filter').addEventListener('change',renderRecords);
  $('sale-form').addEventListener('input', () => {
    const form = $('sale-form');
    const values = ['richard','anastasia','jean_claude'].map((key) => Number(form.elements[key].value));
    const sum = values.reduce((total,value) => total+value,0);
    $('split-total').textContent = percent(sum);
    $('split-total').parentElement.classList.toggle('invalid',Math.abs(sum-100)>0.00001);
    $('pool-preview').textContent = `Pool ${money(Math.round(Number(form.elements.amount.value || 0)*10))}`;
  });
  $('sale-form').addEventListener('submit',async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    const split = [Number(fields.richard),Number(fields.anastasia),Number(fields.jean_claude)];
    try {validateSplit(split);} catch(error) {showMessage(error.message,true);return;}
    const result = await perform({action:'sale',reference:fields.reference.trim(),customer:fields.customer.trim(),project:fields.project,description:fields.description.trim(),amount:fields.amount,split},form,(value) => `${fields.reference.trim()} saved as Pending approval. ${money(value.transaction?.amountCents ?? Math.round(Number(fields.amount)*100))} · ${allocation(fields.project)}. Income and commissions remain excluded until approval.`);
    if(result) {form.reset();form.dispatchEvent(new Event('input'));}
  });
  $('expense-form').addEventListener('submit',async (event) => {
    event.preventDefault();
    const form=event.currentTarget;
    const fields=Object.fromEntries(new FormData(form));
    const result=await perform({action:'expense',reference:fields.reference.trim(),description:fields.description.trim(),amount:fields.amount,category:fields.category,allocation:fields.allocation},form,`${fields.reference.trim()} saved. ${fields.allocation === 'Company overhead' ? 'Company overhead allocated automatically.' : 'Awaiting allocation.'} The expense is included in company result.`);
    if(result) form.reset();
  });
  $('record-list').addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-decision]');
    if (!form) return;
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    const reference = form.dataset.reference;
    if (form.dataset.decision === 'sale') {
      const split = [Number(fields.split0),Number(fields.split1),Number(fields.split2)];
      try {validateSplit(split);} catch(error) {showMessage(error.message,true);return;}
      await perform({action:'approveSale',reference,split},form,`${reference} approved. The final split and earned commissions are saved; delivery status is shown on the record.`);
    } else await perform({action:'allocateExpense',reference,allocation:fields.allocation},form,`${reference} allocated to ${allocation(fields.allocation)}. Company expenses have not been deducted again.`);
  });
  $('record-list').addEventListener('input', (event) => {
    const form = event.target.closest('[data-decision]');
    if (form) dirtyDecisions.add(form.dataset.reference);
  });
  $('record-list').addEventListener('change', (event) => {
    const form = event.target.closest('[data-decision]');
    if (form) dirtyDecisions.add(form.dataset.reference);
  });
  $('record-list').addEventListener('click',async (event) => {
    const button=event.target.closest('[data-retry]');
    if(button) await perform({action:'retry',reference:button.dataset.reference,channel:button.dataset.retry},button.parentElement,`${button.dataset.reference}: delivery retry processed. Check the updated status on the record.`);
  });
  $('mapping-form').addEventListener('submit',async(event) => {
    event.preventDefault();
    const form=event.currentTarget;
    const fields=Object.fromEntries(new FormData(form));
    const result=await perform({action:'linkTelegram',telegramUserId:fields.userId.trim(),employeeId:fields.employee},form,`Telegram user ${fields.userId.trim()} linked to ${EMPLOYEES[fields.employee].name}. Existing transaction destinations are preserved.`);
    if(result) form.reset();
  });
  $('mapping-list').addEventListener('click',async(event) => {
    const button=event.target.closest('[data-unlink]');
    if(button) await perform({action:'linkTelegram',telegramUserId:button.dataset.unlink,employeeId:null},button.parentElement,`Telegram user ${button.dataset.unlink} unlinked. Existing saved records are unchanged.`);
  });
  document.querySelectorAll('[data-failure]').forEach((checkbox) => checkbox.addEventListener('change',async(event) => {
    const checked=event.target.checked;
    const result=await perform({action:'setFailure',channel:event.target.dataset.failure,enabled:checked},event.target.parentElement,`${event.target.dataset.failure === 'sheets' ? 'Google Sheets' : 'Telegram'} interruption ${checked ? 'enabled. Saved transactions remain intact.' : 'disabled. Retry any incomplete deliveries from their records.'}`);
    if(!result) event.target.checked=!checked;
  }));
  loadState({initial:true});
  // Fetch saved state quietly; the server drains healthy pending delivery jobs.
  // Failed deliveries still require an explicit manager retry.
  setInterval(() => loadState({quiet:true}),30000);
})();

