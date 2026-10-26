// The "Start free trial" form on the pricing page and /start. It posts to
// /api/billing/checkout-session with no email: Stripe asks for it. This script
// only keeps the form honest: the plan follows the billing toggle, ad tags in
// the address ride along as hidden fields, and a failed checkout is announced.
(() => {
  const forms = document.querySelectorAll('form[data-web-checkout]');
  if (!forms.length) return;
  const query = new URLSearchParams(location.search);
  const tags = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const landing = location.pathname.replace(/^\/(?:de|fr|es|it|ja|ko|zh|pt-br)(?=\/)/, '').replace(/^\/|\.html$/g, '') || 'home';
  forms.forEach(form => {
    tags.forEach(tag => {
      const value = query.get(tag);
      if (!value) return;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = tag;
      input.value = value.slice(0, 200);
      form.appendChild(input);
    });
    const from = form.querySelector('[name="landing"]') || form.appendChild(Object.assign(document.createElement('input'), { type: 'hidden', name: 'landing' }));
    if (!from.value) from.value = landing;
    const plan = form.querySelector('[data-web-checkout-plan]');
    document.querySelectorAll('input[name="billing"]').forEach(radio => radio.addEventListener('change', () => {
      if (radio.checked && plan) plan.value = radio.value;
    }));
  });
  const error = document.querySelector('[data-web-checkout-error]');
  if (error) error.hidden = query.get('checkout') !== 'failed';
})();
