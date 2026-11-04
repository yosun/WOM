import { api, type CreditsInfo } from './api.ts';
import { currentUser } from './auth.ts';
import { clear, h } from './dom.ts';
import { memoryMark } from './home-memory.ts';
import { createKeyholeLight, type KeyholeLight } from './keyhole-light.ts';
import { keyholePath } from './keyhole.ts';

let accounts = 0;
const BEFORE = 'wom.credits.before';
const number = (n: number) => n.toLocaleString();
const PACK_DESCRIPTIONS: Record<string, string> = {
  starter: 'A spark of inspiration',
  explorer: 'More room to explore',
  creator: 'Keep the ideas flowing',
  studio: 'For a growing collection',
};

/** The account opens into a little shop; its light is the same one that invites you into a memory. */
export function createHomeAccount(providerBalance: HTMLElement) {
  const me = currentUser();
  if (!me) return null;

  const id = `credits-${++accounts}`;
  const events = new AbortController();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let current: number | null = null;
  let info: CreditsInfo | null = null;
  let light: KeyholeLight | null = null;
  let frame = 0;
  let paymentTimer = 0;
  let loading: Promise<CreditsInfo | null> | null = null;
  let catalogKey = '';

  const navBalance = h('span.home-account-balance', { hidden: true, 'aria-hidden': 'true' });
  const button = h('button.home-account', {
    type: 'button', 'aria-label': 'Account & credits', 'aria-haspopup': 'dialog', 'aria-controls': id, 'aria-expanded': 'false',
  }, memoryMark('home-account-keyhole'), h('span', 'Account', h('span.home-account-label', ' & credits')), navBalance);

  const close = h('button.credits-close', { type: 'button', 'aria-label': 'Close account and credits', autofocus: true }, '×');
  const art = h('div.credits-portal', { 'aria-hidden': 'true' });
  const balanceValue = h('strong.credits-balance-value', '…');
  const balanceHint = h('span.credits-balance-hint', 'Loading your balance');
  const creationCost = h('span.credits-creation-cost');
  const feedback = h('p.credits-feedback', { role: 'status', hidden: true });
  const packs = h('div.credit-packs');
  const shop = h('section.credits-shop', { hidden: true, 'aria-label': 'Credit packs' },
    h('div.credits-shop-heading', h('h3', 'Fuel your next idea'), h('span', 'One-time purchase')),
    packs,
    h('p.credits-pricing-note', 'Credits currently cover initial 3D scene creation.'),
    h('p.credits-checkout', h('span', { 'aria-hidden': 'true' }, '◇'), 'Checkout with Stripe · Pay once, create at your own pace'),
  );
  const testNote = h('p.credits-test-note', { hidden: true });
  const emptyText = h('p', 'Loading your credit packs…');
  const retry = h('button', { type: 'button', hidden: true }, 'Try again');
  const empty = h('div.credits-empty', emptyText, retry);

  const code = h('input', { type: 'text', placeholder: 'WOM-XXXX-XXXX', maxlength: 24, 'aria-label': 'Promo code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false });
  const redeem = h('button', { type: 'submit' }, 'Redeem');
  const promoMessage = h('p.credits-form-feedback', { role: 'status', hidden: true });
  const redeemForm = h('form.credits-form', h('div.credits-input-row', code, redeem), promoMessage);
  const promo = h('details.credits-promo', { hidden: true }, h('summary', 'Have a promo code?'), redeemForm);

  const name = h('input', { id: `${id}-handle`, type: 'text', value: me.handle ?? '', placeholder: 'your-name', maxlength: 30, autocomplete: 'off', spellcheck: false });
  const link = h('p.credits-helper', me.handle ? `${location.host}/u/${me.handle}/…` : 'Choose a name for your share links.');
  const handle = h('span.credits-handle', me.handle ? `@${me.handle}` : 'Your personal link');
  const rename = h('button', { type: 'submit' }, 'Save');
  const profileMessage = h('p.credits-form-feedback', { role: 'status', hidden: true });
  const profileForm = h('form.credits-form', h('label.credits-label', { for: name.id }, 'Your name in share links'), h('div.credits-input-row', name, rename), link, profileMessage);
  const profile = h('details.credits-settings',
    h('summary', h('span', 'Your account'), handle), profileForm,
    me.role === 'admin' ? h('div.credits-provider', h('span', 'AI3D balance'), providerBalance) : '',
  );

  const dialog = h('dialog.credits-dialog', { id, 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-description` },
    h('div.credits-topline', h('span', 'A world of possibility'), close),
    h('header.credits-hero', art,
      h('h2', { id: `${id}-title` }, 'Make more of a memory.'),
      h('p', { id: `${id}-description` }, 'Create 3D scenes and objects. Capture new perspectives. Bring still moments to life with video.'),
    ),
    h('div.credits-body',
      h('div.credits-balance', { role: 'status' },
        h('div', h('span.credits-label', 'Your balance'), h('div', balanceValue, h('span.credits-balance-unit', ' credits'))),
        h('div.credits-balance-context', balanceHint, creationCost),
      ),
      feedback, shop, empty, testNote, promo, profile,
    ),
  );

  // No animation runs while the dialog is closed or the tab is hidden. Reduced motion holds the same light still.
  function syncLight() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (disposed || !dialog.open || document.hidden) return;
    if (!light) {
      light = createKeyholeLight(`${id}-light`);
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 240 158');
      const defs = document.createElementNS(ns, 'defs');
      defs.append(...light.defs, ...light.lineDefs);
      const geo = { cx: 120, cy: 70, size: 56 };
      const plate = document.createElementNS(ns, 'path');
      plate.setAttribute('d', keyholePath(geo));
      plate.setAttribute('fill', light.plateFill);
      svg.append(defs, light.glow, plate, light.sheen, light.line);
      art.append(svg);
      light.fit(geo, 1);
    }
    light.frame(performance.now() / 1000, 1, 1, 1, 1);
    if (!reducedMotion.matches) frame = requestAnimationFrame(syncLight);
  }

  function open() {
    if (disposed || dialog.open || !dialog.isConnected) return;
    dialog.showModal();
    dialog.scrollTop = 0;
    button.setAttribute('aria-expanded', 'true');
    document.body.classList.add('account-open');
    syncLight();
    if (!info && !loading) void refresh().catch(showError);
  }

  button.addEventListener('click', open);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    button.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('account-open');
    syncLight();
  });
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect();
    if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
  });
  document.addEventListener('visibilitychange', syncLight, { signal: events.signal });
  reducedMotion.addEventListener('change', () => { light = null; clear(art); syncLight(); }, { signal: events.signal });

  function showBalance(balance: number | null, worldCredits: number, unlimited: boolean) {
    current = balance;
    balanceValue.textContent = unlimited ? 'Unlimited' : number(balance ?? 0);
    dialog.querySelector<HTMLElement>('.credits-balance-unit')!.hidden = unlimited;
    balanceHint.textContent = unlimited ? 'Your account builds for free' : 'For your next creation';
    creationCost.textContent = unlimited ? 'Make yourself at home.' : `Current scene rate · ${number(worldCredits)} credits`;
    navBalance.textContent = unlimited ? '∞' : number(balance ?? 0);
    navBalance.hidden = false;
    promo.hidden = unlimited;
  }

  function showPacks(c: CreditsInfo) {
    shop.hidden = c.packs.length === 0;
    empty.hidden = !shop.hidden;
    emptyText.textContent = c.unlimited ? 'You’re all set. Your account can create scenes without credits.' : 'Credit packs aren’t available right now. You can still redeem a code below.';
    retry.hidden = true;
    testNote.hidden = !c.testMode || shop.hidden;
    testNote.textContent = 'Test checkout · No money moves. Use 4242 4242 4242 4242, any future date and any CVC.';
    // A balance refresh must not replace the checkout link someone is using with the keyboard.
    const key = JSON.stringify([c.packs, c.worldCredits, c.testMode, c.unlimited]);
    if (key === catalogKey) return;
    catalogKey = key;
    clear(packs);
    const starter = c.packs.reduce<(typeof c.packs)[number] | null>((best, p) => !best || p.usd < best.usd ? p : best, null);
    const base = starter ? starter.credits / starter.usd : 0;
    const bestRate = Math.max(...c.packs.map((p) => p.credits / p.usd));
    for (const p of c.packs) {
      const more = base ? Math.round((p.credits / p.usd / base - 1) * 100) : 0;
      const recommended = p.id === 'explorer' && c.packs.length > 1;
      const bestValue = more > 0 && p.credits / p.usd === bestRate;
      const price = p.usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
      const a = h('a.credit-pack', { href: p.url, class: recommended ? 'is-recommended' : '', 'aria-label': `${p.name}: ${number(p.credits)} credits for ${price} USD. Buy with Stripe.` },
        h('span.credit-pack-ribbon', recommended ? 'Recommended' : bestValue ? 'Best value' : ''),
        h('span.credit-pack-name', p.name),
        h('span.credit-pack-amount', h('strong', number(p.credits)), h('span', 'credits')),
        h('span.credit-pack-description', PACK_DESCRIPTIONS[p.id] ?? 'For your next creation'),
        h('span.credit-pack-bonus', more > 0 ? `+${more}% extra credits` : ''),
        h('span.credit-pack-price', h('strong', price), h('span', 'USD')),
        h('span.credit-pack-cta', 'Get credits', h('span', { 'aria-hidden': 'true' }, '↗')),
      );
      a.addEventListener('click', () => {
        try { sessionStorage.setItem(BEFORE, String(current ?? 0)); } catch { /* Checkout also works without browser storage. */ }
      });
      packs.append(a);
    }
  }

  async function refresh(): Promise<CreditsInfo | null> {
    if (loading) return loading;
    loading = (async () => {
      const c = await api.credits();
      if (disposed) return null;
      info = c;
      showBalance(c.balance, c.worldCredits, c.unlimited);
      showPacks(c);
      return c;
    })();
    try { return await loading; } finally { loading = null; }
  }

  function showError() {
    if (disposed) return;
    balanceHint.textContent = 'Your balance is temporarily unavailable';
    empty.hidden = false;
    emptyText.textContent = 'We couldn’t load your credit packs. Give it another try.';
    retry.hidden = false;
  }

  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try { await refresh(); } catch { showError(); } finally { retry.disabled = false; }
  });

  function formFeedback(el: HTMLElement, message: string, error = false) {
    el.textContent = message;
    el.dataset.kind = error ? 'error' : 'success';
    el.setAttribute('role', error ? 'alert' : 'status');
    el.hidden = false;
  }

  redeemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!code.value.trim() || redeem.disabled) return;
    redeem.disabled = true;
    redeem.textContent = 'Adding…';
    promoMessage.hidden = true;
    try {
      const r = await api.redeem(code.value.trim());
      if (disposed) return;
      code.value = '';
      showBalance(r.balance, r.worldCredits, false);
      if (info) info = { ...info, balance: r.balance, worldCredits: r.worldCredits };
      formFeedback(promoMessage, 'A little more possibility. Your credits have been added.');
    } catch (err) {
      if (!disposed) formFeedback(promoMessage, (err as Error).message, true);
    } finally {
      redeem.disabled = false;
      redeem.textContent = 'Redeem';
    }
  });

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (rename.disabled) return;
    rename.disabled = true;
    rename.textContent = 'Saving…';
    profileMessage.hidden = true;
    try {
      const r = await api.setHandle(name.value);
      if (disposed) return;
      name.value = r.user.handle ?? '';
      handle.textContent = r.user.handle ? `@${r.user.handle}` : 'Your personal link';
      link.textContent = `${location.host}/u/${r.user.handle}/…`;
      formFeedback(profileMessage, 'Saved. Links with your old name keep working.');
    } catch (err) {
      if (!disposed) formFeedback(profileMessage, (err as Error).message, true);
    } finally { rename.disabled = false; rename.textContent = 'Save'; }
  });

  // Only a changed server balance confirms a purchase. The return URL alone is not a payment receipt.
  const paidForCredits = new URLSearchParams(location.search).get('credits') === 'paid';
  if (paidForCredits) {
    const url = new URL(location.href);
    url.searchParams.delete('credits');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    let before = NaN;
    try { before = Number(sessionStorage.getItem(BEFORE) ?? NaN); sessionStorage.removeItem(BEFORE); } catch { /* No previous balance. */ }
    feedback.hidden = false;
    feedback.textContent = 'Welcome back. Waiting for your credits to arrive…';
    let attempts = 0;
    const watchPayment = async () => {
      const c = await refresh().catch(() => { showError(); return null; });
      if (disposed) return;
      if (c && Number.isFinite(before) && (c.balance ?? 0) > before) {
        feedback.textContent = 'Your credits are here. Time to bring another memory to life.';
        dialog.classList.add('is-credited');
        return;
      }
      if (c && !Number.isFinite(before)) {
        feedback.textContent = 'Your balance is up to date. A recent payment may take a moment to appear.';
        return;
      }
      if (++attempts >= 12) {
        feedback.textContent = 'Still waiting for your credits. If you completed checkout, check back in a minute.';
        return;
      }
      paymentTimer = window.setTimeout(() => void watchPayment(), attempts === 1 ? 1200 : 2500);
    };
    void watchPayment();
  } else {
    void refresh().catch(showError);
  }

  return {
    button, dialog, open, paidForCredits,
    dispose() {
      disposed = true;
      clearTimeout(paymentTimer);
      cancelAnimationFrame(frame);
      events.abort();
      if (dialog.open) dialog.close();
      document.body.classList.remove('account-open');
    },
  };
}
