/**
 * @param {{
 *   connect: (credentials: { url: string, token: string }) => Promise<{ persisted?: boolean } | null | undefined>,
 *   onConnected?: (result: { persisted?: boolean } | null | undefined) => unknown,
 *   document?: Document,
 * }} options
 */
export function createHASetupForm({ connect, onConnected = () => {}, document = globalThis.document }) {
  const form = document.createElement('form');
  form.className = 'login-form';

  const address = document.createElement('input');
  address.type = 'text';
  address.inputMode = 'url';
  address.placeholder = 'http://homeassistant.local:8123';

  const token = document.createElement('input');
  token.type = 'password';

  /** @type {[string, HTMLInputElement][]} */
  const fields = [['Home Assistant URL', address], ['Long-lived access token', token]];
  for (const [caption, input] of fields) {
    input.required = true;
    input.autocomplete = 'off';
    input.spellcheck = false;
    const label = document.createElement('label');
    label.textContent = caption;
    label.append(input);
    form.append(label);
  }

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary';
  submit.textContent = 'Connect Home Assistant';

  const note = document.createElement('p');
  note.className = 'sync-note';
  note.textContent = 'Enter your credentials on the TV. Phone QR setup is unavailable on stock webOS.';

  const status = document.createElement('p');
  status.className = 'sync-note';
  status.setAttribute('role', 'status');

  form.append(submit, note, status);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    status.textContent = 'Connecting to Home Assistant…';
    try {
      const result = await connect({ url: address.value, token: token.value });
      token.value = '';
      status.textContent = result?.persisted === true
        ? 'Connected. Credentials saved in protected storage.'
        : 'Connected for this session. Enter your credentials again after restarting.';
      await onConnected(result);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}
