/**
 * Hold Option (Alt) alone to peek through privacy mode.
 *
 * "Alone" carries the safety: Option is a modifier for half the keyboard, and
 * an Option-chord or Alt+click that flashed every name would make the mode
 * useless on a recording. Blur ends a peek because Cmd-Tab means the keyup
 * never arrives.
 */
export function createPeekController({ onChange, holdMs = 250, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let on = false;
  let spoiled = false; // another input happened during this Alt hold

  const set = (next) => { if (next !== on) { on = next; onChange(next); } };
  const cancelTimer = () => { if (timer) { clearTimer(timer); timer = null; } };
  const end = () => { cancelTimer(); set(false); };

  return {
    keydown(e) {
      if (e.key === 'Alt') {
        if (e.repeat || timer || on || spoiled) return;
        timer = setTimer(() => { timer = null; set(true); }, holdMs);
        return;
      }
      spoiled = true;
      end();
    },
    keyup(e) {
      if (e.key === 'Alt') { spoiled = false; end(); }
    },
    pointerdown() { spoiled = true; end(); },
    blur() { spoiled = false; end(); },
    dispose() { end(); },
  };
}
