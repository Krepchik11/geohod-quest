'use client';

interface Props {
  balance: number;
}

// Tiny derived display (parent always passes projectBalance(facts)).
export function CoinDisplay({ balance }: Props) {
  return <span className="font-mono text-sm">🪙 {balance}</span>;
}
