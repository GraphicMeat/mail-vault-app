import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MailArrivalCelebration } from './src/components/MailArrivalCelebration';
import './src/styles/index.css';

function Preview() {
  const [run, setRun] = useState(0);
  const [open, setOpen] = useState(true);
  const [kind, setKind] = useState('account');
  const replay = (nextKind) => {
    setKind(nextKind);
    setRun((value) => value + 1);
    setOpen(true);
  };

  return (
    <main className="min-h-screen bg-mail-bg text-mail-text grid place-items-center text-center p-6">
      <div>
        <h1 className="font-display text-2xl font-bold mb-3">MailVault arrival preview</h1>
        <p className="text-sm text-mail-text-muted mb-5">Choose a moment to replay.</p>
        <div className="flex gap-3 justify-center">
          <button type="button" onClick={() => replay('account')} className="px-5 py-2 rounded-lg bg-mail-accent-fill text-white font-medium">
            Replay account added
          </button>
          <button type="button" onClick={() => replay('onboarding')} className="px-5 py-2 rounded-lg bg-mail-surface text-mail-text border border-mail-border font-medium">
            Replay onboarding
          </button>
        </div>
      </div>
      {open && <MailArrivalCelebration key={run} kind={kind} onClose={() => setOpen(false)} />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Preview />);
