import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

// One number, typed or stepped. Typing shifts digits in from the right, the
// way a clock field does: "0" "2" "5" reads 02 then 25. Steps and typed
// values both go through the caller, which clamps the total.
export function Spin({ value, label, onType, onStep, testId }) {
  const stepClass = 'flex items-center justify-center h-4 w-5 rounded text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover';
  return (
    <div className="flex items-center gap-0.5">
      <input
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-label={label}
        aria-valuenow={value}
        data-testid={testId}
        value={String(value).padStart(2, '0')}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onType(Number(e.target.value.replace(/\D/g, '').slice(-2)) || 0)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          onStep(e.key === 'ArrowUp' ? 1 : -1);
        }}
        className="w-11 h-9 text-center text-lg tabular-nums text-mail-text bg-mail-bg border border-mail-border
                  rounded-md outline-none focus:border-mail-accent"
      />
      <div className="flex flex-col">
        <button type="button" tabIndex={-1} aria-hidden="true" data-testid={`${testId}-up`} onClick={() => onStep(1)} className={stepClass}>
          <ChevronUp size={12} />
        </button>
        <button type="button" tabIndex={-1} aria-hidden="true" data-testid={`${testId}-down`} onClick={() => onStep(-1)} className={stepClass}>
          <ChevronDown size={12} />
        </button>
      </div>
    </div>
  );
}
