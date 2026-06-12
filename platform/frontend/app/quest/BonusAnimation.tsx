'use client';

interface Props {
  message: string | null;
}

// Stub: visual + voice on gift_claimed/terminal (triggered from client claim). Auto hide parent.
export function BonusAnimation({ message }: Props) {
  if (!message) return null;
  return <div className="mb-2 animate-pulse text-sm text-amber-600">{message}</div>;
}
