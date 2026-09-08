import { useCallback, useReducer } from 'react';

const INITIAL_STATE = { status: 'closed', request: null, nextId: 1 };

function transition(state, action) {
  switch (action.type) {
    case 'open': {
      // A generic Settings button resumes the current session. A destination
      // is a new navigation request, including repeated links to the same page.
      if (!action.tab && state.request) return { ...state, status: 'open' };
      return {
        status: 'open',
        nextId: state.nextId + 1,
        request: {
          id: state.nextId,
          tab: action.tab || null,
          accountId: action.accountId || null,
          section: action.section || null,
        },
      };
    }
    case 'minimize':
      return state.status === 'open' ? { ...state, status: 'minimized' } : state;
    case 'close':
      return { ...state, status: 'closed', request: null };
    default:
      return state;
  }
}

/** Owns Settings visibility separately from the lifetime of its form state. */
export function useSettingsWindow() {
  const [state, dispatch] = useReducer(transition, INITIAL_STATE);
  const openSettings = useCallback(({ tab, accountId, section } = {}) => {
    dispatch({ type: 'open', tab, accountId, section });
  }, []);
  const closeSettings = useCallback(() => dispatch({ type: 'close' }), []);
  const minimizeSettings = useCallback(() => dispatch({ type: 'minimize' }), []);

  return {
    status: state.status,
    request: state.request,
    isMounted: state.status !== 'closed',
    isOpen: state.status === 'open',
    isMinimized: state.status === 'minimized',
    openSettings,
    closeSettings,
    minimizeSettings,
  };
}
