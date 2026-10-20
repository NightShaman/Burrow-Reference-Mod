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
  refresh.addEventListener('click', load); root.replaceChildren(section); void load();
  return () => { mounted = false; controller.abort(); refresh.removeEventListener('click', load); root.replaceChildren(); };
}
