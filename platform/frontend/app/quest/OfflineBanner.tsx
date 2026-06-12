'use client';

interface Props {
  simOffline: boolean;
  onToggle: () => void;
  onSimSync: () => void;
  // reconnect enhance (3 optional props; keep <30LOC, no bloat per 5.1/react)
  pendingCount?: number;
  isSyncing?: boolean;
  corrMessage?: string | null;
}

// Focused: shows when sim or pending; checkbox + sim-sync btn (no net, just banner per YAGNI).
// Explicit conds; pending count only when >0 && !sim; isSyncing/corr via parent (timeout clear for msg).
export function OfflineBanner({ simOffline, onToggle, onSimSync, pendingCount = 0, isSyncing = false, corrMessage = null }: Props) {
  return (
    <div className="rounded border bg-yellow-50 p-1 text-[10px] dark:bg-yellow-950">
      {isSyncing ? 'syncing...' : corrMessage ? corrMessage : (simOffline ? 'Offline — local only' : 'Sim online')}
      <label className="ml-2 cursor-pointer">
        <input type="checkbox" checked={simOffline} onChange={onToggle} className="mr-1 align-middle" />
        simulate disconnect
      </label>
      <button onClick={onSimSync} disabled={simOffline} className="ml-2 underline disabled:opacity-40">
        simulate sync
      </button>
      {pendingCount > 0 && !simOffline && !isSyncing && !corrMessage && <span className="ml-1">({pendingCount} pending)</span>}
    </div>
  );
}
