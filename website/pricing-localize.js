/* Browser-region pricing. Manual amounts and fallback mirror src/utils/pricing.js.
 * Automatic uses billing country detection; browser region is an offline fallback.
 * Page language controls number formatting, not the choice of currency.
 */
(function () {
  var nodes = document.querySelectorAll('[data-mv-price]');
  if (!nodes.length) return;

  var region = null;
  var tags = Array.from(navigator.languages || []).concat(navigator.language || []);
  tags.some(function (tag) {
    try { region = new Intl.Locale(tag).region; } catch (e) { region = null; }
    return !!region;
  });
  var autoCurrency = region === 'US' ? 'usd' : (region === 'GB' || region === 'UK') ? 'gbp' : 'eur';
  var choice = 'auto';
  var cachedCurrency;
  try { cachedCurrency = localStorage.getItem('mv-last-auto-currency'); } catch(e) {}
  if (['eur','usd','gbp'].includes(cachedCurrency)) autoCurrency = cachedCurrency;
  var currency = choice === 'auto' ? autoCurrency : choice;
  var amounts;
  var requestVersion = 0;
  var priceTimer;
  function reveal() { document.documentElement.classList.remove('mv-prices-pending'); }
  function format(minor) {
    var digits = minor % 100 === 0 ? 0 : 2;
    return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
      style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits
    }).format(minor / 100);
  }

  function zeroIn(currency) {
    try {
      // Follow the page's own language: the localized copies quote the same
      // currency but write it the way their reader does ("0 €", not "€0").
      return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
        style: 'currency', currency: currency.toUpperCase(),
        minimumFractionDigits: 0, maximumFractionDigits: 0,
      }).format(0);
    } catch (e) { return null; }
  }

  function render(data) {
      if (!data || !Array.isArray(data.plans) || data.currency !== currency) return;

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

      // Optional English savings copy; amounts use the API's hundredths convention.
      var annualMonthly = monthly.amount * 12;
      var savingsValid = Number.isFinite(monthly.amount) && monthly.amount > 0 &&
        Number.isFinite(yearly.amount) && yearly.amount >= 0 && annualMonthly > yearly.amount &&
        (!monthly.currency || monthly.currency === data.currency) &&
        (!yearly.currency || yearly.currency === data.currency);
      if (savingsValid) {
        function money(amount) {
          var digits = amount % 100 === 0 ? 0 : 2;
          return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
            style: 'currency', currency: (data.currency || 'usd').toUpperCase(),
            minimumFractionDigits: digits, maximumFractionDigits: digits
          }).format(amount / 100);
        }
        values['{annualMonthly}'] = money(annualMonthly);
        values['{annualSavings}'] = money(annualMonthly - yearly.amount);
        values['{savingsPercent}'] = String(Math.round((1 - yearly.amount / annualMonthly) * 100));
      }
      document.querySelectorAll('[data-mv-saving]').forEach(function (el) { el.hidden = !savingsValid; });

      Array.prototype.forEach.call(nodes, function (el) {
        var text = el.getAttribute('data-mv-price');
        if (/\{(?:annualMonthly|annualSavings|savingsPercent)\}/.test(text) && !savingsValid) return;
        Object.keys(values).forEach(function (token) {
          text = text.split(token).join(values[token]);
        });
        el.textContent = text;
      });
  }
  function update() {
    currency = choice === 'auto' ? autoCurrency : choice;
    amounts = { eur: [400, 2500], usd: [400, 2500], gbp: [350, 2100] }[currency];
    var version = ++requestVersion;
    clearTimeout(priceTimer);
    var finished = false;
    function finish() { if (finished) return; finished = true; clearTimeout(priceTimer); reveal(); }
    priceTimer = setTimeout(finish, Math.max(0, Math.min(4000, (window.mvPriceDeadline || Date.now()+4000)-Date.now())));
    window.mvPriceDeadline = null;
    if (choice !== 'auto') reveal();
    document.querySelectorAll('[data-currency-select]').forEach(function (select) { select.value = choice; });
    render({ currency: currency, plans: [
      { interval: 'month', currency: currency, amount: amounts[0], formattedAmount: format(amounts[0]) },
      { interval: 'year', currency: currency, amount: amounts[1], formattedAmount: format(amounts[1]), monthlyEquivalent: format(Math.round(amounts[1] / 12)) }
    ] });
    if (window.fetch) fetch('/api/billing/pricing' + (choice === 'auto' ? '' : '?currency=' + currency), { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (version !== requestVersion || finished) return;
        if (choice === 'auto' && data && ['eur','usd','gbp'].includes(data.currency)) {
          currency = data.currency;
          autoCurrency = currency;
          try { localStorage.setItem('mv-last-auto-currency', currency); } catch(e) {}
          document.querySelectorAll('[data-currency-select] option[value="auto"]').forEach(function (option) {
            option.textContent = 'Automatic (' + currency.toUpperCase() + ')';
          });
        }
        render(data);
        finish();
      })
      .catch(function () { finish(); });
    else finish();
  }
  update();
})();
