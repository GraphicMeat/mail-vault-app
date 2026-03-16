import React from 'react';
import { AlertTriangle } from 'lucide-react';

export function LinkAlertIcon({ level, size = 14 }) {
  if (!level) return null;
  return (
    <AlertTriangle
      size={size}
      className={`flex-shrink-0 ${level === 'red' ? 'text-red-500' : 'text-amber-500'}`}
      title={level === 'red' ? 'Dangerous links detected' : 'Suspicious links detected'}
    />
  );
}
