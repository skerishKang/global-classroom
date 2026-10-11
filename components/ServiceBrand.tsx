import React from 'react';
import { BrandLogo } from './BrandLogo';

export default function ServiceBrand({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      <BrandLogo />
      <div className="min-w-0 group" title={title}>
        <h1 className="text-xl font-black text-gray-900 tracking-tight leading-none uppercase transition-colors group-hover:text-indigo-600">{title}</h1>
        <p className="text-[10px] text-gray-400 font-bold tracking-widest mt-1 uppercase transition-colors group-hover:text-indigo-400">{subtitle}</p>
      </div>
    </div>
  );
}
