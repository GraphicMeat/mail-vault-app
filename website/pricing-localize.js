/* Browser-region pricing. Manual amounts and fallback mirror src/utils/pricing.js.
 * Automatic uses billing country detection; browser region is an offline fallback.
 * Page language controls number formatting, not the choice of currency.
 * Minor units per currency: [monthly, yearly, standard monthly, standard yearly].
 * The first two are the Early Bird & Family Pricing charged today; the standard
 * price after early access mirrors MANUAL_AMOUNTS in website/api/pricing.js and
 * stands in when an older API answer has no `standard` block.
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
  var AMOUNTS = { eur: [400, 2500, 600, 3900], usd: [400, 2500, 600, 3900], gbp: [350, 2100, 500, 3300] };
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
      function money(amount) {
        var digits = amount % 100 === 0 ? 0 : 2;
        return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
          style: 'currency', currency: (data.currency || 'usd').toUpperCase(),
          minimumFractionDigits: digits, maximumFractionDigits: digits
        }).format(amount / 100);
      }

      var values = {
        '{monthly}': monthly.formattedAmount,
        '{yearly}': yearly.formattedAmount,
        '{monthlyEquivalent}': yearly.monthlyEquivalent || monthly.formattedAmount,
        '{zero}': zero,
      };

      // Standard price after early access: the API's when it sends one, otherwise
      // this file's table for the same currency, so the page never mixes currencies.
      var table = AMOUNTS[data.currency];
      var standard = data.standard;
      var standardValid = !!standard && typeof standard.formattedYearly === 'string' && standard.formattedYearly &&
        typeof standard.formattedMonthly === 'string' && standard.formattedMonthly && Number.isFinite(standard.yearly);
      var standardYearly = standardValid ? standard.yearly : table && table[3];
      if (standardValid) {
        values['{standardMonthly}'] = standard.formattedMonthly;
        values['{standardYearly}'] = standard.formattedYearly;
      } else if (table) {
        values['{standardMonthly}'] = money(table[2]);
        values['{standardYearly}'] = money(table[3]);
      }
      var earlyYearly = Number.isFinite(yearly.amount) ? yearly.amount : table && table[1];
      if (Number.isFinite(earlyYearly) && Number.isFinite(standardYearly) && earlyYearly > 0 && standardYearly > earlyYearly) {
        values['{earlyBirdSavingsPercent}'] = String(Math.round((1 - earlyYearly / standardYearly) * 100));
      }

      // Optional English savings copy; amounts use the API's hundredths convention.
      var annualMonthly = monthly.amount * 12;
      var savingsValid = Number.isFinite(monthly.amount) && monthly.amount > 0 &&
        Number.isFinite(yearly.amount) && yearly.amount >= 0 && annualMonthly > yearly.amount &&
        (!monthly.currency || monthly.currency === data.currency) &&
        (!yearly.currency || yearly.currency === data.currency);
      if (savingsValid) {
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
        // A token this answer could not fill keeps the text already shown, never the raw token.
        if (/\{(?:standardMonthly|standardYearly|earlyBirdSavingsPercent)\}/.test(text)) return;
        el.textContent = text;
      });
  }
  function update() {
    currency = choice === 'auto' ? autoCurrency : choice;
    amounts = AMOUNTS[currency];
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
    ], standard: { monthly: amounts[2], yearly: amounts[3], formattedMonthly: format(amounts[2]), formattedYearly: format(amounts[3]) } });
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
