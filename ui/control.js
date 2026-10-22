function element(tagName, options = {}, ...children) {
  const node = document.createElement(tagName);
  for (const [name, value] of Object.entries(options)) {
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}
function message(error, fallback) { return error instanceof Error && error.message ? error.message : fallback; }
export function mountControl({ root, api }) {
  const controller = new AbortController(); let mounted = true;
  const greeting = element('p', { className: 'settings-description' });
  const secretState = element('p', { className: 'settings-help' });
  const feedback = element('p', { role: 'status', 'aria-live': 'polite' });
  const refresh = element('button', { type: 'button', className: 'secondary', text: 'Refresh status' });
  const section = element('section', { className: 'setting-section', 'aria-labelledby': 'reference-mod-status-heading' }, element('h2', { id: 'reference-mod-status-heading', text: 'Burrow Reference Mod' }), greeting, secretState, feedback, element('div', { className: 'card-actions' }, refresh));
  async function load() { refresh.disabled = true; feedback.className = ''; feedback.setAttribute('role', 'status'); feedback.textContent = 'Loading status…'; try { const status = await api('/status', { signal: controller.signal }); if (!mounted) return; if (!status || status.ok !== true || typeof status.greeting !== 'string' || typeof status.secretConfigured !== 'boolean') throw new Error('The mod returned an invalid status response.'); greeting.textContent = status.greeting; secretState.textContent = status.secretConfigured ? 'The optional example secret is configured.' : 'The optional example secret is not configured.'; feedback.textContent = 'Status loaded.'; } catch (error) { if (!mounted || controller.signal.aborted) return; feedback.className = 'settings-request-error'; feedback.setAttribute('role', 'alert'); feedback.textContent = message(error, 'Could not load the reference mod status.'); } finally { if (mounted) refresh.disabled = false; } }
  refresh.addEventListener('click', load); root.replaceChildren(section); const cleanupImages = mountImages({ root, api }); void load();
  return () => { mounted = false; controller.abort(); cleanupImages(); refresh.removeEventListener('click', load); root.replaceChildren(); };
}

// Only Core-authenticated, same-origin image previews; never accept an arbitrary
// scheme/origin, query-string credential, or download URL as an image source.
export function safeImagePreviewUrl(value) {
  return typeof value === 'string' && /^\/api\/forge\/jobs\/[a-zA-Z0-9_-]+\/artifacts\/[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

function mountImages({ root, api }) {
  const controller = new AbortController();
  let mounted = true;
  let available = false;
  let pending = false;
  let terminal = true;
  const prompt = element('textarea', { id: 'reference-image-prompt', maxlength: '4000', rows: '3' });
  const consent = element('input', { type: 'checkbox' });
  const availability = element('p');
  const feedback = element('p', { role: 'status', 'aria-live': 'polite' });
  const preview = element('div');
  const submit = element('button', { type: 'submit', text: 'Create image (may incur cost)' });
  const retry = element('button', { type: 'button', text: 'Retry saved submission' });
  const poll = element('button', { type: 'button', text: 'Poll saved image job' });
  const form = element('form', {}, element('label', { for: prompt.id }, 'Image prompt', prompt), element('label', {}, consent, ' I authorize this potentially paid image request.'), submit);
  const panel = element('section', { className: 'setting-section' }, element('h2', { text: 'Ordinary-mod Forge image example' }), element('p', { text: 'Uses the operator’s saved Forge image selection. Submitted jobs cannot be cancelled. Poll later, including after reloading this page.' }), availability, form, retry, poll, feedback, preview);
  root.append(panel);
  function controls(busy = false) {
    submit.disabled = busy || !available || pending || !terminal;
    retry.disabled = busy || !pending;
    retry.hidden = !pending;
    poll.disabled = busy;
    prompt.disabled = busy || pending || !terminal;
    consent.disabled = busy;
  }
  function renderJob(job) {
    preview.replaceChildren();
    terminal = !job || ['succeeded', 'failed', 'interrupted'].includes(job.status);
    feedback.textContent = job ? `Job ${job.id}: ${job.status}${terminal ? ' (terminal)' : ' — poll again later'}.${job.error ? ` Error: ${typeof job.error === 'string' ? job.error : job.error.code}` : ''}` : pending ? 'Submission receipt unknown. Retry the saved request with the same idempotency key.' : 'No saved image job.';
    if (job?.status === 'succeeded') {
      for (const artifact of job.artifacts || []) {
        const src = safeImagePreviewUrl(artifact.previewUrl);
        if (artifact.kind === 'image' && src) preview.append(element('img', { src, alt: 'Generated image preview', loading: 'lazy', referrerpolicy: 'no-referrer', style: 'max-width:100%;height:auto' }));
      }
    }
  }
  async function load() {
    controls(true);
    try {
      const status = await api('/images/status', { signal: controller.signal });
      if (!mounted) return;
      if (status?.ok !== true || typeof status.available !== 'boolean') throw new Error('Image status unavailable.');
      available = status.available; pending = status.retryPending === true;
      availability.textContent = available ? 'Forge images available.' : `Forge images unavailable${status.reason ? `: ${status.reason}` : '.'}`;
      const result = await api('/images/job', { signal: controller.signal });
      if (!mounted) return;
      if (result?.ok !== true) throw new Error('Image job unavailable.');
      renderJob(result.job);
    } catch {
      if (mounted && !controller.signal.aborted) { terminal = false; preview.replaceChildren(); feedback.textContent = 'Could not read image status/job. Poll again later; do not assume completion.'; }
    }
    finally { if (mounted) controls(); }
  }
  async function create(event) {
    event.preventDefault();
    if (!consent.checked || (!pending && !prompt.value.trim())) { feedback.textContent = 'Enter a prompt and authorize the potential cost before submission or retry.'; return; }
    controls(true);
    try {
      const body = { confirmCost: true, ...(!pending ? { prompt: prompt.value } : {}) };
      const result = await api('/images', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (!mounted) return;
      if (result?.ok !== true || !result.job?.id) throw new Error('Submission failed');
      pending = false; consent.checked = false; renderJob(result.job);
    } catch {
      if (mounted && !controller.signal.aborted) { await load(); if (mounted) feedback.textContent = `Submission not confirmed. ${feedback.textContent}`; }
    }
    finally { if (mounted) controls(); }
  }
  form.addEventListener('submit', create); retry.addEventListener('click', create); poll.addEventListener('click', load);
  void load();
  return () => { mounted = false; controller.abort(); form.removeEventListener('submit', create); retry.removeEventListener('click', create); poll.removeEventListener('click', load); panel.remove(); };
}
