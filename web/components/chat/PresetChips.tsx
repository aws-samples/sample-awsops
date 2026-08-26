'use client';
import { AUTO_PRESETS } from '@/lib/sections';

// Auto-routing is the default, so the starter chips are the generic AUTO_PRESETS. (Per-section
// `presets` in lib/sections.ts are retained as data for a possible future per-section hint.)
export default function PresetChips({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-4">
      <div className="mb-1 text-center text-[13px] text-ink-500">무엇을 도와드릴까요?</div>
      {AUTO_PRESETS.map((p) => (
        <button
          key={p}
          onClick={() => onPick(p)}
          className="rounded-xl border border-ink-100 bg-card px-3.5 py-2.5 text-left text-[13px] text-ink-700 shadow-sm transition-colors hover:border-brand-200 hover:bg-brand-50"
        >
          <span className="mr-1.5 text-brand-500">▸</span>{p}
        </button>
      ))}
    </div>
  );
}
