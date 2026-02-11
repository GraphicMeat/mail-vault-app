import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, X, CheckCircle, Info, AlertTriangle } from 'lucide-react';

export function Toast({ message, type = 'error', duration = 5000, onClose }) {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  const icons = {
    error: AlertCircle,
    success: CheckCircle,
    info: Info,
    warning: AlertTriangle
  };

  const colors = {
    error: 'bg-mail-danger/10 border-mail-danger/20 text-mail-danger',
    success: 'bg-mail-success/10 border-mail-success/20 text-mail-success',
    info: 'bg-mail-accent/10 border-mail-accent/20 text-mail-accent',
    warning: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-500'
  };
  
  const Icon = icons[type] || AlertCircle;
  const colorClass = colors[type] || colors.error;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 50, x: '-50%' }}
      animate={{ opacity: 1, y: 0, x: '-50%' }}
      exit={{ opacity: 0, y: 50, x: '-50%' }}
      className={`fixed bottom-6 left-1/2 flex items-center gap-3 px-4 py-3 
                 border rounded-xl shadow-lg backdrop-blur-sm ${colorClass}`}
    >
      <Icon size={18} />
      <span className="text-sm font-medium max-w-md">{message}</span>
      <button
        onClick={onClose}
        className="p-1 hover:bg-white/10 rounded transition-colors ml-2"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}
