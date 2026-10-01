const money = (cents, currency = window.ISOLDE_CURRENCY || 'CAD') =>
  new Intl.NumberFormat(document.documentElement.lang === 'ar' ? 'ar-CA' : 'en-CA', {
    style: 'currency', currency
  }).format((Number(cents) || 0) / 100);

const cartKey = 'isolde_cart_v1';
const getCart = () => {
  try { return JSON.parse(localStorage.getItem(cartKey) || '[]'); } catch { return []; }
};
const saveCart = (cart) => {
  localStorage.setItem(cartKey, JSON.stringify(cart));
  updateCartCount();
};
const updateCartCount = () => {
  const count = getCart().reduce((n, i) => n + Number(i.qty || 0), 0);
  document.querySelectorAll('[data-cart-count]').forEach(el => el.textContent = count);
};
const toast = (message) => {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = message; el.classList.add('show');
  clearTimeout(window.__isoldeToast); window.__isoldeToast = setTimeout(() => el.classList.remove('show'), 2200);
};

function addToCart(product, qty = 1) {
  const cart = getCart();
  const row = cart.find(i => i.id === product.id);
  if (row) row.qty += qty; else cart.push({ ...product, qty });
  saveCart(cart);
  toast(document.documentElement.lang === 'ar' ? 'تمت الإضافة إلى السلة' : 'Added to your bag');
}

function bindAddButtons() {
  document.querySelectorAll('[data-add-to-cart]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = JSON.parse(btn.dataset.product);
      const qtyInput = btn.closest('[data-product-buy]')?.querySelector('[name="qty"]');
      const qty = Math.max(1, Number(qtyInput?.value || 1));
      addToCart(p, qty);
    });
  });
}

function shippingFor(subtotal) {
  const cfg = window.ISOLDE_SHIPPING || {mode:'quote'};
  if (cfg.mode === 'quote') return null;
  if (cfg.mode === 'free') return 0;
  if (Number(cfg.freeThresholdCents || 0) > 0 && subtotal >= Number(cfg.freeThresholdCents)) return 0;
  return Number(cfg.flatFeeCents || 0);
}

function renderCartPage() {
  const mount = document.querySelector('[data-cart-page]');
  if (!mount) return;
  const empty = document.querySelector('[data-cart-empty]');
  const summary = document.querySelector('[data-cart-summary]');
  const cart = getCart();
  if (!cart.length) {
    mount.innerHTML = '';
    empty?.removeAttribute('hidden');
    summary?.setAttribute('hidden', '');
    return;
  }
  empty?.setAttribute('hidden', '');
  summary?.removeAttribute('hidden');
  mount.innerHTML = cart.map(item => `
    <article class="cart-row" data-id="${item.id}">
      <a href="/product/${item.slug}" class="cart-thumb"><img src="${item.image}" alt=""></a>
      <div class="cart-copy">
        <a href="/product/${item.slug}" class="cart-name">${escapeHtml(item.name)}</a>
        ${item.inspiredBy ? `<div class="muted small">Inspired by ${escapeHtml(item.inspiredBy)}</div>` : ''}
        <div class="cart-price">${item.priceCents > 0 ? money(item.priceCents) : 'Price pending'}</div>
      </div>
      <div class="qty-control">
        <button type="button" data-dec aria-label="Decrease">−</button>
        <input value="${item.qty}" inputmode="numeric" aria-label="Quantity">
        <button type="button" data-inc aria-label="Increase">+</button>
      </div>
      <button type="button" class="link-button remove" data-remove>Remove</button>
    </article>`).join('');

  const recalc = () => {
    const current = getCart();
    const subtotal = current.reduce((sum, i) => sum + (Number(i.priceCents)||0) * Number(i.qty||0), 0);
    document.querySelectorAll('[data-cart-subtotal]').forEach(el => el.textContent = money(subtotal));
    document.querySelectorAll('[data-cart-items]').forEach(el => el.textContent = current.reduce((n,i)=>n+i.qty,0));
  };

  mount.querySelectorAll('.cart-row').forEach(row => {
    const id = Number(row.dataset.id);
    const input = row.querySelector('input');
    const update = (delta = 0) => {
      const c = getCart(); const i = c.findIndex(x => x.id === id); if (i < 0) return;
      const next = Math.max(1, Number(input.value || c[i].qty) + delta);
      c[i].qty = next; input.value = next; saveCart(c); recalc();
    };
    row.querySelector('[data-dec]').onclick = () => update(-1);
    row.querySelector('[data-inc]').onclick = () => update(1);
    input.onchange = () => update(0);
    row.querySelector('[data-remove]').onclick = () => {
      saveCart(getCart().filter(i => i.id !== id)); renderCartPage();
    };
  });
  recalc();
}

function renderCheckout() {
  const mount = document.querySelector('[data-checkout-items]');
  const form = document.querySelector('[data-checkout-form]');
  if (!mount || !form) return;
  const cart = getCart();
  if (!cart.length) {
    location.href = '/cart'; return;
  }
  mount.innerHTML = cart.map(i => `<div class="checkout-line"><span>${escapeHtml(i.name)} × ${i.qty}</span><strong>${i.priceCents > 0 ? money(i.priceCents*i.qty) : '—'}</strong></div>`).join('');
  const subtotal = cart.reduce((s,i)=>s+(Number(i.priceCents)||0)*i.qty,0);
  const shipping = shippingFor(subtotal);
  const total = shipping == null ? null : subtotal + shipping;
  document.querySelectorAll('[data-checkout-subtotal]').forEach(el => el.textContent = money(subtotal));
  document.querySelectorAll('[data-checkout-shipping]').forEach(el => el.textContent = shipping == null ? 'To be confirmed' : (shipping === 0 ? 'Free' : money(shipping)));
  document.querySelectorAll('[data-checkout-total]').forEach(el => el.textContent = total == null ? `${money(subtotal)} + shipping` : money(total));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true; submit.dataset.original = submit.textContent; submit.textContent = 'Processing…';
    const data = Object.fromEntries(new FormData(form).entries());
    data.items = cart.map(i => ({id:i.id, qty:i.qty}));
    const fingerprint=JSON.stringify(data);
    let attempt;
    try { attempt=JSON.parse(sessionStorage.getItem('isolde_checkout_attempt')||'null'); } catch {}
    if(!attempt || attempt.fingerprint!==fingerprint) attempt={fingerprint,key:crypto.randomUUID()};
    sessionStorage.setItem('isolde_checkout_attempt',JSON.stringify(attempt));
    data.checkout_key=attempt.key;
    try {
      const res = await fetch('/api/orders', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Could not place order');
      if (out.checkoutUrl) { location.href = out.checkoutUrl; return; }
      localStorage.removeItem(cartKey); updateCartCount();
      sessionStorage.removeItem('isolde_checkout_attempt');
      location.href = `/order/success?order=${encodeURIComponent(out.orderNumber)}`;
    } catch (err) {
      toast(err.message); submit.disabled = false; submit.textContent = submit.dataset.original;
    }
  });
}

function bindShopFilters() {
  const root = document.querySelector('[data-shop-grid]');
  if (!root) return;
  const search = document.querySelector('[data-shop-search]');
  const audience = document.querySelector('[data-shop-audience]');
  const category = document.querySelector('[data-shop-category]');
  const sort = document.querySelector('[data-shop-sort]');
  const cards = [...root.querySelectorAll('[data-product-card]')];
  const params = new URLSearchParams(location.search);
  if (audience && params.get('audience')) audience.value = params.get('audience');
  if (category && params.get('category')) category.value = params.get('category');
  if (search && params.get('q')) search.value = params.get('q');

  const apply = () => {
    const q = (search?.value || '').trim().toLowerCase();
    const aud = audience?.value || '';
    const cat = category?.value || '';
    cards.forEach(c => {
      const show = (!q || c.dataset.search.includes(q)) && (!aud || c.dataset.audience === aud) && (!cat || c.dataset.category === cat);
      c.hidden = !show;
    });
    const visible = cards.filter(c=>!c.hidden);
    visible.sort((a,b) => {
      if (sort?.value === 'price-asc') return (+a.dataset.price)-(+b.dataset.price);
      if (sort?.value === 'price-desc') return (+b.dataset.price)-(+a.dataset.price);
      if (sort?.value === 'name') return a.dataset.name.localeCompare(b.dataset.name);
      return (+a.dataset.order)-(+b.dataset.order);
    }).forEach(c=>root.appendChild(c));
    const count = document.querySelector('[data-shop-count]');
    if (count) count.textContent = visible.length;
  };
  [search,audience,category,sort].forEach(el => el?.addEventListener(el===search?'input':'change', apply));
  apply();
}

function bindGallery() {
  const main = document.querySelector('.gallery-main img');
  if (!main) return;
  document.querySelectorAll('[data-gallery-thumb]').forEach(btn => {
    btn.addEventListener('click', () => {
      main.src = btn.dataset.image;
      document.querySelectorAll('[data-gallery-thumb]').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

function escapeHtml(str='') { return String(str).replace(/[&<>'"]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m])); }

document.addEventListener('DOMContentLoaded', () => {
  if(document.querySelector('[data-payment-confirmed]')) {
    localStorage.removeItem(cartKey);
    sessionStorage.removeItem('isolde_checkout_attempt');
  }
  updateCartCount(); bindAddButtons(); renderCartPage(); renderCheckout(); bindShopFilters(); bindGallery();
  const menuBtn = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-mobile-menu]');
  menuBtn?.addEventListener('click', ()=>menu?.classList.toggle('open'));
});
