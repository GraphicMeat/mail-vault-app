import React from 'react';

export function EmailRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-mail-border animate-pulse">
      {/* Checkbox placeholder */}
      <div className="w-4 h-4 bg-mail-border rounded" />

      {/* Local/Server indicator placeholder */}
      <div className="w-5 flex items-center justify-center">
        <div className="w-3.5 h-3.5 bg-mail-border rounded" />
      </div>

      {/* Star placeholder */}
      <div className="w-4 h-4 bg-mail-border rounded" />

      {/* Sender placeholder */}
      <div className="w-48">
        <div className="h-4 bg-mail-border rounded w-32" />
      </div>

      {/* Subject & Preview placeholder */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <div className="h-4 bg-mail-border rounded w-3/4" />
      </div>

      {/* Date placeholder */}
      <div className="w-16">
        <div className="h-4 bg-mail-border rounded w-12" />
      </div>

      {/* Actions placeholder - hidden like in real row */}
      <div className="w-16 flex items-center gap-1 opacity-0">
        <div className="w-6 h-6 bg-mail-border rounded" />
        <div className="w-6 h-6 bg-mail-border rounded" />
      </div>
    </div>
  );
}
