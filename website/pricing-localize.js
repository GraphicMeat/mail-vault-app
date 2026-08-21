/*
 * Progressive currency localization for the price copy.
 *
 * The static HTML quotes USD — that is what crawlers, the JSON-LD offers and any
 * no-JS visitor see, and it stays the canonical number. But checkout bills in the
 * currency /api/billing/pricing resolves from the request country, so a UK
 * visitor reading "$4/month" here is charged £3.50. This swaps the visible
 * amounts to that same resolved currency, which is also what the app's paywalls
 * quote (src/hooks/usePremiumPricing.js).
 *
 * Any failure — offline, rate limited, malformed payload — leaves the USD markup
 * untouched. A price on the page is never replaced by a spinner or a gap.
 *
 * Markup contract: data-mv-price holds a template over {monthly}, {yearly},
 * {monthlyEquivalent} and {zero}, e.g. data-mv-price="~{monthlyEquivalent}/month".
 * Only the annotated element's text is rewritten, so wrap the price phrase in its
 * own <span> when the sentence around it carries links.
 */
(function () {
  var nodes = document.querySelectorAll('[data-mv-price]');
  if (!nodes.length || !window.fetch) return;

  function zeroIn(currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: currency.toUpperCase(),
        minimumFractionDigits: 0, maximumFractionDigits: 0,
      }).format(0);
    } catch (e) { return null; }
  }

  fetch('/api/billing/pricing', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.plans) return;

      var monthly = null, yearly = null;
      data.plans.forEach(function (plan) {
        if (plan.interval === 'month') monthly = plan;
        else if (plan.interval === 'year') yearly = plan;
      });
      if (!monthly || !yearly || !monthly.formattedAmount || !yearly.formattedAmount) return;

      var zero = zeroIn(data.currency || 'usd');
      if (!zero) return;

      var values = {
        '{monthly}': monthly.formattedAmount,
        '{yearly}': yearly.formattedAmount,
        '{monthlyEquivalent}': yearly.monthlyEquivalent || monthly.formattedAmount,
        '{zero}': zero,
      };

      Array.prototype.forEach.call(nodes, function (el) {
        var text = el.getAttribute('data-mv-price');
        Object.keys(values).forEach(function (token) {
          text = text.split(token).join(values[token]);
        });
        el.textContent = text;
      });
    })
    .catch(function () { /* keep the USD markup */ });
})();
