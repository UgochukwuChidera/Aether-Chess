import React from 'react';
export const ExtensionsView: React.FC = () => (
  <div className="flex flex-col items-center justify-center gap-3 py-16">
    <span className="material-symbols-outlined text-inactive" style={{ fontSize: 48 }}>extension</span>
    <p className="text-sm font-sans text-muted text-center">
      Extensions coming soon.<br />Community plugins and themes will appear here.
    </p>
  </div>
);
