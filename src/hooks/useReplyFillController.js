import { useRef } from 'react';
import { createReplyFillController } from '../services/replyFill';

// App's existing owner wiring, extracted so real React replay/commit tests
// exercise the same boundary as the production window list.
export function useReplyFillController({ windows, setWindows, getContext, onError }) {
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const controller = useRef(null);
  if (!controller.current) controller.current = createReplyFillController({
    getWindows: () => windowsRef.current, setWindows, getContext, onError,
  });
  return controller.current;
}
