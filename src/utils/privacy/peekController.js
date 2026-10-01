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
  let altHeld = false; // whether Alt key is currently held
  let spoiled = false; // another input happened while altHeld
  let disposed = false;

  const set = (next) => { if (next !== on) { on = next; onChange(next); } };
  const cancelTimer = () => { if (timer) { clearTimer(timer); timer = null; } };
  const end = () => { cancelTimer(); set(false); };

  return {
    keydown(e) {
      if (disposed) return;
      if (e.key === 'Alt') {
        if (e.repeat || timer || on || spoiled || e.shiftKey || e.ctrlKey || e.metaKey) return;
        altHeld = true;
        timer = setTimer(() => { timer = null; set(true); }, holdMs);
        return;
      }
      // Non-Alt keydown
      if (altHeld) {
        spoiled = true;
      }
      end();
    },
    keyup(e) {
      if (disposed) return;
      if (e.key === 'Alt') {
        altHeld = false;
        spoiled = false;
        end();
      }
    },
    pointerdown() {
      if (disposed) return;
      if (altHeld) {
        spoiled = true;
      }
      end();
    },
    blur() {
      if (disposed) return;
      altHeld = false;
      spoiled = false;
      end();
    },
    dispose() {
      disposed = true;
      altHeld = false;
      spoiled = false;
      end();
    },
  };
}
