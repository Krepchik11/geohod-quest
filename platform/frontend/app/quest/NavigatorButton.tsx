'use client';

interface Props {
  lat: number;
  lng: number;
  label?: string;
  onUsed: () => void; // parent appends 'navigator_used' + opens url
}

// Focused: conditional render only (parent decides physical-ish + supporting.navigator present). Click -> append + maps.
export function NavigatorButton({ lat, lng, label = 'Открыть навигатор', onUsed }: Props) {
  const handle = () => {
    onUsed();
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    if (typeof window !== 'undefined') window.open(url, '_blank');
  };
  return (
    <button onClick={handle} className="ml-2 rounded border px-2 py-0.5 text-xs">
      🗺️ {label}
    </button>
  );
}
