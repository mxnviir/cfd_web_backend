// Buying credits and the unlimited pass, through PayPal.
//
// The client only proposes a credit count or a number of months. The price
// and what is granted are worked out again on the server, in the
// createPayPalOrder and capturePayPalOrder functions.

import React, { useEffect, useRef, useState } from "react";
import { db, functions } from "../lib/firebase.js";
import { TransactionsList } from "../components/TransactionsList.jsx";
import { listPrice, LIMITS } from "../lib/pricing.js";

// A run at the Workbench's own defaults, priced by the rule the server charges
// by. This page used to say "100 credits = 1 simulation variant", which was
// true of none of them: the default run is 150.
const STANDARD_RUN = listPrice({
  refine_level: LIMITS.refineLevel.default,
  iteration_count: LIMITS.iterations.default,
  debug_mesh: false,
});

const BILLING_DEFAULTS = {
  usdPer100Credits: 5,       // "$5 per 100 credits" = $0.05 / credit (normal rate)
  currency: 'USD',
  minCredits: 100,
  maxCredits: 10000,
  step: 50,
  unlimitedMonthlyUSD: 100,  // default $/month for the unlimited pass
  unlimitedDays: 30,
  maxUnlimitedMonths: 24,
  paypalClientId: ''
};

const BillingView = ({
  user,
  credits,
  isSignedIn,
  onRequireAuth
}) => {
  const [cfg, setCfg] = useState(BILLING_DEFAULTS);
  const [amountCredits, setAmountCredits] = useState(500);
  const [status, setStatus] = useState(null); // { type: 'processing'|'success'|'error', msg }
  const [sdkReady, setSdkReady] = useState(false);
  const [unlimitedUntil, setUnlimitedUntil] = useState(0); // ms epoch, 0 = none
  const [unlimitedStartedAt, setUnlimitedStartedAt] = useState(0); // ms epoch when current pass began
  const [userRate, setUserRate] = useState(0); // per-user USD/credit override; 0 = use global
  const [userUnlimitedUsd, setUserUnlimitedUsd] = useState(0); // per-user $/month override; 0 = use global
  const [months, setMonths] = useState(1);
  const [showCreditPay, setShowCreditPay] = useState(false);
  const [showUnlimitedPay, setShowUnlimitedPay] = useState(false);

  const paypalContainerRef = useRef(null);
  const unlimitedContainerRef = useRef(null);
  const buttonsRef = useRef([]);
  const amountRef = useRef(amountCredits);
  amountRef.current = amountCredits;
  const monthsRef = useRef(months);
  monthsRef.current = months;

  // 1. Live pricing config from Firestore (backend-configurable)
  useEffect(() => {
    const ref = db.collection('config').doc('pricing');
    const unsub = ref.onSnapshot(snap => {
      const d = snap.exists && snap.data() || {};
      setCfg({
        usdPer100Credits: Number(d.usdPer100Credits) > 0 ? Number(d.usdPer100Credits) : BILLING_DEFAULTS.usdPer100Credits,
        currency: typeof d.currency === 'string' && d.currency ? d.currency : BILLING_DEFAULTS.currency,
        minCredits: Number(d.minCredits) > 0 ? Math.floor(Number(d.minCredits)) : BILLING_DEFAULTS.minCredits,
        maxCredits: Number(d.maxCredits) > 0 ? Math.floor(Number(d.maxCredits)) : BILLING_DEFAULTS.maxCredits,
        step: Number(d.step) > 0 ? Math.floor(Number(d.step)) : BILLING_DEFAULTS.step,
        unlimitedMonthlyUSD: Number(d.unlimitedMonthlyUSD) > 0 ? Number(d.unlimitedMonthlyUSD) : BILLING_DEFAULTS.unlimitedMonthlyUSD,
        unlimitedDays: Number(d.unlimitedDays) > 0 ? Math.floor(Number(d.unlimitedDays)) : BILLING_DEFAULTS.unlimitedDays,
        maxUnlimitedMonths: Number(d.maxUnlimitedMonths) > 0 ? Math.floor(Number(d.maxUnlimitedMonths)) : BILLING_DEFAULTS.maxUnlimitedMonths,
        paypalClientId: typeof d.paypalClientId === 'string' && d.paypalClientId
          ? d.paypalClientId
          : (window.PAYPAL_CLIENT_ID || '')
      });
    }, err => {
      console.warn('Pricing config load failed, using defaults:', err && err.message);
      setCfg(c => ({ ...c, paypalClientId: c.paypalClientId || window.PAYPAL_CLIENT_ID || '' }));
    });
    return () => unsub();
  }, []);

  // 1b. Live "unlimited pass" status from the user doc.
  useEffect(() => {
    if (!isSignedIn || !user || !user.uid) { setUnlimitedUntil(0); setUnlimitedStartedAt(0); setUserRate(0); setUserUnlimitedUsd(0); return; }
    const unsub = db.collection('users').doc(user.uid).onSnapshot(snap => {
      const u = snap.exists && snap.data() || {};
      const until = u.unlimitedUntil;
      const ms = until && typeof until.toMillis === 'function' ? until.toMillis()
        : (until && until.seconds ? until.seconds * 1000 : 0);
      setUnlimitedUntil(ms || 0);
      var startedRaw = u.unlimitedStartedAt;
      var startedMs = startedRaw && typeof startedRaw.toMillis === 'function' ? startedRaw.toMillis() : (startedRaw && startedRaw.seconds ? startedRaw.seconds * 1000 : 0);
      setUnlimitedStartedAt(startedMs || 0);
      setUserRate(Number(u.usdPerCredit) > 0 ? Number(u.usdPerCredit) : 0);
      setUserUnlimitedUsd(Number(u.unlimitedUsd) > 0 ? Number(u.unlimitedUsd) : 0);
    }, () => {});
    return () => unsub();
  }, [isSignedIn, user && user.uid]);

  // Keep the chosen amount within the configured bounds / step.
  useEffect(() => {
    setAmountCredits(c => clampCredits(c, cfg));
  }, [cfg.minCredits, cfg.maxCredits, cfg.step]);

  function clampCredits(v, c) {
    let n = Math.round((Number(v) || 0) / c.step) * c.step;
    if (!isFinite(n)) n = c.minCredits;
    return Math.min(c.maxCredits, Math.max(c.minCredits, n));
  }

  const rate = userRate > 0 ? userRate : cfg.usdPer100Credits / 100;      // USD per credit (per-user override wins)
  const priceUSD = amountCredits * rate;
  const priceStr = priceUSD.toFixed(2);
  const unlimitedPerMonth = userUnlimitedUsd > 0 ? userUnlimitedUsd : cfg.unlimitedMonthlyUSD;
  const unlimitedMonths = Math.max(1, Number(months) || 1);
  const unlimitedTotalStr = (unlimitedMonths * unlimitedPerMonth).toFixed(2);
  const clientId = cfg.paypalClientId;

  // 2. Load the PayPal SDK once the client id is known.
  useEffect(() => {
    if (!clientId) return;
    if (window.paypal) { setSdkReady(true); return; }
    const existing = document.getElementById('paypal-sdk');
    if (existing) {
      existing.addEventListener('load', () => setSdkReady(true));
      return;
    }
    const s = document.createElement('script');
    s.id = 'paypal-sdk';
    s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) +
            '&currency=' + encodeURIComponent(cfg.currency) + '&intent=capture';
    s.onload = () => setSdkReady(true);
    s.onerror = () => setStatus({ type: 'error', msg: 'Could not load PayPal. Check the client ID or your connection.' });
    document.body.appendChild(s);
  }, [clientId, cfg.currency]);

  // 3. Render the PayPal Smart Buttons (once) when ready + signed in.
  //    One set for the credit top-up, one for the unlimited pass.
  useEffect(() => {
    if (!sdkReady || !window.paypal || !isSignedIn) return;

    const createOrderFn = functions.httpsCallable('createPayPalOrder');
    const captureFn = functions.httpsCallable('capturePayPalOrder');

    const makeButtons = (product, container) => {
      if (!container) return null;
      container.innerHTML = '';
      const btns = window.paypal.Buttons({
        style: { layout: 'vertical', color: product === 'unlimited' ? 'gold' : 'blue', shape: 'rect', label: 'paypal' },
        createOrder: async () => {
          setStatus({ type: 'processing', msg: 'Creating your order.', product });
          // createPayPalOrder discriminates on `product`, so the credits
          // branch has to name itself too — without it the request is
          // rejected as invalid rather than silently priced wrong.
          const payload = product === 'unlimited'
            ? { product: 'unlimited', months: monthsRef.current }
            : { product: 'credits', credits: amountRef.current };
          const res = await createOrderFn(payload);
          return res.data.order_id;
        },
        onApprove: async data => {
          setStatus({ type: 'processing', msg: 'Confirming your payment.', product });
          try {
            const res = await captureFn({ order_id: data.orderID });
            if ((res.data && res.data.product) === 'unlimited') {
              setStatus({ type: 'success', msg: 'The unlimited pass is active. Every simulation is free while it lasts.', product });
            } else {
              const n = res.data && res.data.credits || amountRef.current;
              setStatus({ type: 'success', msg: 'Payment complete. ' + n.toLocaleString() + ' credits were added to your account.', product });
            }
          } catch (e) {
            setStatus({ type: 'error', msg: 'PayPal took the payment but it was not applied to your account. Contact us with your PayPal receipt and we will add it by hand. ' + (e && e.message ? e.message : ''), product });
          }
        },
        onCancel: () => setStatus({ type: 'error', msg: 'Payment cancelled. No charge was made.', product }),
        onError: err => {
          console.error('PayPal error', err);
          setStatus({ type: 'error', msg: 'PayPal reported an error and no payment was taken: ' + (err && err.message ? err.message : 'no reason given') + '.', product });
        }
      });
      try { btns.render(container); } catch (e) { console.error('Failed to render PayPal buttons', e); }
      return btns;
    };

    buttonsRef.current = [
      makeButtons('credits', paypalContainerRef.current),
      makeButtons('unlimited', unlimitedContainerRef.current)
    ];

    return () => {
      (buttonsRef.current || []).forEach(b => {
        try { if (b && b.close) b.close(); } catch (e) {}
      });
    };
  }, [sdkReady, isSignedIn, showCreditPay, showUnlimitedPay]);

  const setCreditsRaw = v => {
    const n = parseInt((v + '').replace(/[^\d]/g, ''), 10);
    setAmountCredits(isNaN(n) ? '' : n);
  };

  const unlimitedActive = unlimitedUntil > Date.now();
  const unlimitedUntilStr = unlimitedActive
    ? new Date(unlimitedUntil).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  const unlimitedDaysLeft = unlimitedActive ? Math.ceil((unlimitedUntil - Date.now()) / 86400000) : 0;
  const unlimitedTotalDays = unlimitedActive
    ? Math.max(unlimitedDaysLeft, unlimitedStartedAt > 0 ? Math.round((unlimitedUntil - unlimitedStartedAt) / 86400000) : unlimitedDaysLeft)
    : 0;
  const unlimitedPct = (unlimitedActive && unlimitedTotalDays > 0)
    ? Math.max(0, Math.min(100, Math.round(unlimitedDaysLeft / unlimitedTotalDays * 100)))
    : 0;

  // A status line under the offer it is about. One with no product (the
  // PayPal script failing to load) is about checkout as a whole, so it goes
  // under the first offer.
  const statusFor = (product) => status && (status.product || 'credits') === product
    ? <p className={'billing-status is-' + status.type} role={status.type === 'error' ? 'alert' : 'status'}>{status.msg}</p>
    : null;
  const notConfigured = <p className="billing-status is-error">PayPal checkout is not set up on this site yet, so nothing can be bought here.</p>;
  const months1 = Math.min(cfg.maxUnlimitedMonths, unlimitedMonths);

  return (
    <article className="page billing">
      <header className="page-head">
        <h1 className="t-h1">Buy credits</h1>
        <p className="t-body">
          Credits pay for simulations. A standard run is {STANDARD_RUN} credits,
          and the Workbench shows the exact price before you queue one.
        </p>
      </header>

      {isSignedIn && (
        <section className="billing-balance">
          <div className="billing-balance-row">
            <div>
              <div className="t-caption">Current balance</div>
              <span className="t-data-lg">{credits.toLocaleString()}</span>
              <span className="t-unit">credits</span>
            </div>
            <p className="t-small">
              Enough for {Math.floor(credits / STANDARD_RUN)} standard {Math.floor(credits / STANDARD_RUN) === 1 ? 'run' : 'runs'}.
            </p>
          </div>
          <TransactionsList user={user} />
        </section>
      )}

      {isSignedIn && unlimitedActive && (
        <section className="billing-pass-status">
          <div className="billing-offer-head">
            <div>
              <h2 className="t-h3">Unlimited pass active</h2>
              <p className="t-small">Every simulation runs free until {unlimitedUntilStr}.</p>
            </div>
            <span className="t-data">{unlimitedDaysLeft + (unlimitedDaysLeft === 1 ? ' day left' : ' days left')}</span>
          </div>
          <div className="meter meter-lg"><div style={{ width: unlimitedPct + '%' }} /></div>
          <div className="billing-range-ends t-caption">
            <span>{unlimitedDaysLeft} of {unlimitedTotalDays} days left</span>
            <span>{unlimitedPct}%</span>
          </div>
        </section>
      )}

      <section className="billing-offer">
        <div className="billing-offer-head">
          <h2 className="t-h2">Credits</h2>
          <span className="t-data">{'$' + (rate * 100).toFixed(2) + ' per 100 credits'}</span>
        </div>
        <p className="t-small">
          Choose how many credits you want. Pay with PayPal or any card. The
          credits are added to your account as soon as the payment clears.
        </p>

        <div className="billing-amount">
          <div>
            <label className="field-label" htmlFor="credit-amount">Number of credits</label>
            <div className="number-control billing-number">
              <input id="credit-amount" type="number" className="input-field number-stepper field-input t-data"
                min={cfg.minCredits} max={cfg.maxCredits} step={cfg.step} value={amountCredits}
                onChange={(e) => setCreditsRaw(e.target.value)}
                onBlur={() => setAmountCredits((c) => clampCredits(c, cfg))} />
              <div className="num-btns">
                <button type="button" aria-label="More credits"
                  onClick={() => setAmountCredits((c) => clampCredits((Number(c) || 0) + cfg.step, cfg))}>+</button>
                <button type="button" aria-label="Fewer credits"
                  onClick={() => setAmountCredits((c) => clampCredits((Number(c) || 0) - cfg.step, cfg))}>-</button>
              </div>
            </div>
          </div>
          <div className="billing-total">
            <div className="t-caption">You pay</div>
            <div className="t-data-lg">{'$' + priceStr}</div>
            <div className="t-caption">{(Number(amountCredits) || 0).toLocaleString()} credits, in {cfg.currency}</div>
          </div>
        </div>
        <input type="range" className="billing-range" aria-label="Number of credits"
          min={cfg.minCredits} max={cfg.maxCredits} step={cfg.step} value={clampCredits(amountCredits, cfg)}
          onChange={(e) => setAmountCredits(parseInt(e.target.value, 10))} />
        <div className="billing-range-ends t-caption">
          <span>{cfg.minCredits.toLocaleString()}</span>
          <span>{cfg.maxCredits.toLocaleString()}</span>
        </div>

        {statusFor('credits')}
        {!isSignedIn ? (
          <button type="button" className="btn-primary btn-lg"
            onClick={() => onRequireAuth && onRequireAuth('Sign in to buy credits.')}>Sign in to buy credits</button>
        ) : !clientId ? notConfigured : !showCreditPay ? (
          <button type="button" className="btn-primary btn-lg" onClick={() => setShowCreditPay(true)}>Pay with PayPal</button>
        ) : (
          <div>
            {!sdkReady && <p className="t-small">Loading the PayPal button.</p>}
            <div ref={paypalContainerRef} className="billing-paypal" />
          </div>
        )}
        <p className="t-caption">
          Payments are processed by PayPal. The credits are granted on our
          server once PayPal confirms the payment, so there is nothing to copy
          or paste.
        </p>
      </section>

      <section className="billing-offer">
        <div className="billing-offer-head">
          <h2 className="t-h2">Unlimited pass</h2>
          <span className="t-data">{'$' + unlimitedPerMonth.toFixed(2) + ' a month'}</span>
        </div>
        <p className="t-small">
          Run as many simulations as you want. Every job is free while the pass
          is active, with no credits deducted. Buying while a pass is active
          adds to the time left on it.
        </p>

        <div className="billing-amount">
          <div>
            <label className="field-label" htmlFor="pass-months">Number of months</label>
            <div className="number-control billing-number billing-number-sm">
              <input id="pass-months" type="number" className="input-field number-stepper field-input t-data"
                min={1} max={cfg.maxUnlimitedMonths} step={1} value={months}
                onChange={(e) => { const n = parseInt((e.target.value + '').replace(/[^0-9]/g, ''), 10); setMonths(isNaN(n) ? '' : n); }}
                onBlur={() => setMonths((m) => Math.min(cfg.maxUnlimitedMonths, Math.max(1, Number(m) || 1)))} />
              <div className="num-btns">
                <button type="button" aria-label="One more month"
                  onClick={() => setMonths((m) => Math.min(cfg.maxUnlimitedMonths, (Number(m) || 0) + 1))}>+</button>
                <button type="button" aria-label="One month fewer"
                  onClick={() => setMonths((m) => Math.max(1, (Number(m) || 1) - 1))}>-</button>
              </div>
            </div>
          </div>
          <div className="billing-total">
            <div className="t-caption">You pay</div>
            <div className="t-data-lg">{'$' + unlimitedTotalStr}</div>
            <div className="t-caption">
              {unlimitedMonths} {unlimitedMonths === 1 ? 'month' : 'months'}, {unlimitedMonths * cfg.unlimitedDays} days
            </div>
          </div>
        </div>
        <input type="range" className="billing-range" aria-label="Number of months"
          min={1} max={cfg.maxUnlimitedMonths} step={1} value={months1}
          onChange={(e) => setMonths(parseInt(e.target.value, 10))} />
        <div className="billing-range-ends t-caption">
          <span>1 month</span>
          <span>{cfg.maxUnlimitedMonths} months</span>
        </div>

        {statusFor('unlimited')}
        {/* Secondary, not primary: one filled button per page, and credits
            are what most people come here for. */}
        {!isSignedIn ? (
          <button type="button" className="btn-secondary btn-lg"
            onClick={() => onRequireAuth && onRequireAuth('Sign in to buy the unlimited pass.')}>Sign in to buy the unlimited pass</button>
        ) : !clientId ? notConfigured : !showUnlimitedPay ? (
          <button type="button" className="btn-secondary btn-lg" onClick={() => setShowUnlimitedPay(true)}>Get the unlimited pass</button>
        ) : (
          <div>
            {unlimitedActive && (
              <p className="t-small">
                You already have an active pass, so buying now adds {unlimitedMonths * cfg.unlimitedDays} more days.
              </p>
            )}
            {!sdkReady && <p className="t-small">Loading the PayPal button.</p>}
            <div ref={unlimitedContainerRef} className="billing-paypal" />
          </div>
        )}
      </section>

      <dl className="facts">
        {[{
          t: 'What a run costs',
          b: 'The same for every car, whatever its size. The mesh and the iteration count set the price: '
            + 'every 1,000 iterations cost 100 credits on the coarsest mesh, 25 more for each finer step, '
            + 'and 200 on the finest. The Workbench shows the price before you queue.'
        }, {
          t: 'How to pay',
          b: 'PayPal or any card. Sponsored teams pay a reduced rate, so get in touch before buying.'
        }, {
          t: 'Getting a refund',
          b: 'Cancel while a job is pending or meshing and the credits go back in full. Once it is simulating, they do not.'
        }].map(({ t: term, b }) => (
          <React.Fragment key={term}>
            <dt>{term}</dt>
            <dd>{b}</dd>
          </React.Fragment>
        ))}
      </dl>
    </article>
  );
};

/* -- Lap Time Calculator View ----------------------------------------- */
// Embedded CSV data from co2_thrust_data.csv
/* Field is defined outside LapCalcView so React never remounts it on re-render */

export { BILLING_DEFAULTS, BillingView };
