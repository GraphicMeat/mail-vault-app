// Settings > Mail preferences > Fields on the phone: desktop's Fields view over the engine
// (`mobile.fields.*`, engine `fields.rs`, through the phone's field cache fields.js). The fields
// are the active account's (the account the drawer has open; with no account, none), as desktop's
// page edits its active account's. A change the engine refuses (a name the account has already,
// say) puts the list back and leaves desktop's "could not save" note under the page.
import React, { useCallback, useState } from 'react';
import { FieldsView } from '../../components/settings/views/FieldsView';
import { useMobileStore } from '../store.js';
import { useFieldStore } from '../fields.js';
import { MobileViewEnv, SaveFailed } from './MobileViewEnv.jsx';

export default function Fields() {
  const accounts = useMobileStore((s) => s.accounts);
  const active = useMobileStore((s) => s.activeAccountId);
  const accountId = accounts.some((a) => a.id === active) ? active : accounts[0]?.id || null;
  const fields = useFieldStore((s) => s.fields);
  const [failed, setFailed] = useState(false);
  // Every change goes through here: a refusal is shown, never an unhandled rejection.
  const guard = useCallback((fn) => async (...args) => {
    try {
      const out = await fn(...args);
      setFailed(false);
      return out;
    } catch {
      setFailed(true);
      return null;
    }
  }, []);
  const store = useFieldStore.getState();
  const load = useCallback((id) => useFieldStore.getState().loadFields(id).catch(() => setFailed(true)), []);
  if (!accountId) return null;
  return (
    <MobileViewEnv>
      <FieldsView accountId={accountId} accounts={accounts} fields={fields} onLoad={load}
        onSave={guard(store.saveField)} onDelete={guard(store.deleteField)} onMove={guard(store.moveField)}
        onCopy={guard(store.copyFields)} optionUsage={store.optionUsage} explainerKey="mobile.fields.explainer" />
      <SaveFailed failed={failed} />
    </MobileViewEnv>
  );
}
