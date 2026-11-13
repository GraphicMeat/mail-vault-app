// The phone's first-run tour, as the desktop's (src/components/Onboarding.jsx): one header with
// Back (absent on the first step), "Step N of M" and Skip tour (absent on the last), the step,
// and one action place at the bottom (Continue; "I'll do this later" on the account step; Get
// Started at the end), so the control people press to go on never moves.
//
// `steps` is frozen by the caller (mobileOnboardingSteps): an account added mid-way does not
// renumber the steps under the user. Skip tour and Get Started both mark the tour done in the
// engine (`onboardingComplete`) and call `onFinish()`. The account flows (import, manual add) take
// the whole screen while they run; the tour header comes back with their Back.
//
// System Back (Android) follows the header's Back: it closes a running account flow, else goes to
// the previous step; on the first step it leaves the app as everywhere else (no layer).
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pushLayer } from '../backStack.js';
import { useT } from '../i18n.js';
import { daemonCall } from '../transport.js';
import { useMobileStore } from '../store.js';
import KeyboardLayer from '../KeyboardLayer.jsx';
import LanguageStep from './LanguageStep.jsx';
import AccountStep from './AccountStep.jsx';
import FreeStep from './FreeStep.jsx';
import PremiumStep from './PremiumStep.jsx';

export default function Onboarding({ steps, onAdd, onOAuth, onOAuthCancel, onFinish }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [flow, setFlow] = useState(null); // the account step's running flow: null | 'import' | 'manual'
  const [finishing, setFinishing] = useState(false);
  const hasAccount = useMobileStore((s) => s.accounts.length > 0);
  const bodyRef = useRef(null);

  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [index]);

  const step = steps[index];
  const last = index === steps.length - 1;
  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1));
  const back = () => setIndex((i) => Math.max(i - 1, 0));
  // One back layer while there is somewhere to go back to. A Back the layer took re-arms it
  // (`backs`), so each press goes one step; moving forward keeps the one layer.
  const [backs, setBacks] = useState(0);
  const backable = index > 0 || Boolean(flow);
  const systemBack = useRef(null);
  systemBack.current = () => {
    setBacks((n) => n + 1);
    if (flow) setFlow(null);
    else back();
  };
  useEffect(() => (backable ? pushLayer(() => systemBack.current?.()) : undefined), [backable, backs]);
  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await daemonCall('mobile.settings.set', { onboardingComplete: true });
    } catch {
      // Not stored: the tour shows again on the next launch without accounts, nothing worse.
    }
    onFinish?.();
  };

  if (step === 'account' && flow) {
    return (
      <KeyboardLayer className="mv-tour mv-tour--flow" scroll=".mv-add" data-testid="onboarding-account">
        <AccountStep flow={flow} onFlow={setFlow} onAdd={onAdd} onOAuth={onOAuth} onOAuthCancel={onOAuthCancel} onAdded={next} />
      </KeyboardLayer>
    );
  }

  return (
    <KeyboardLayer className="mv-tour" scroll=".mv-tour__body" data-testid={`onboarding-${step}`}>
      <header className="mv-tour__bar">
        {index > 0 ? (
          <button type="button" className="mv-textbtn" onClick={back} disabled={finishing} data-testid="onboarding-back">
            {t('common.back')}
          </button>
        ) : <span />}
        <span className="mv-tour__progress" role="status">{t('onboarding.progress', { current: index + 1, total: steps.length })}</span>
        {!last ? (
          <button type="button" className="mv-textbtn" onClick={finish} disabled={finishing} data-testid="onboarding-skip">
            {t('onboarding.skipTour')}
          </button>
        ) : <span />}
      </header>
      <div ref={bodyRef} className={`mv-tour__body mv-tour__body--${step}`}>
        {step === 'language' && <LanguageStep />}
        {step === 'account' && <AccountStep flow={null} onFlow={setFlow} onAdded={next} />}
        {step === 'free' && <FreeStep />}
        {step === 'premium' && <PremiumStep />}
        {step === 'done' && (
          <>
            <h1 className="mv-tour__title">{t('mobile.onboarding.doneTitle')}</h1>
            <p className="mv-tour__lead">{t(hasAccount ? 'mobile.onboarding.doneLead' : 'mobile.onboarding.doneLeadNoAccount')}</p>
          </>
        )}
      </div>
      <footer className="mv-tour__actions">
        {step === 'account' ? (
          <button type="button" className="mv-textbtn mv-tour__later" onClick={next}>
            {t('onboarding.skipAccount')}
          </button>
        ) : last ? (
          <button type="button" className="mv-primary" onClick={finish} disabled={finishing} data-testid="onboarding-continue">
            {t('onboarding.getStarted')}
          </button>
        ) : (
          <button type="button" className="mv-primary" onClick={next} data-testid="onboarding-continue">
            {t('common.continue')}
          </button>
        )}
      </footer>
    </KeyboardLayer>
  );
}
