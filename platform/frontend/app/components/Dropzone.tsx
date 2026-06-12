'use client';

import React, { useState } from 'react';

/**
 * Dropzone - design .dropzone (299x180 dashed, photograph icon, text, click/file).
 * Stub for upload (YAGNI real S3; onFile for preview + console or parent state).
 * Small, explicit, accessible (tabindex, role).
 * Used in ctor settings, page editor, gallery.
 */
export default function Dropzone({
  label = 'Выберете изображение на ПК в формате PNG, JPG',
  onFile,
  previewUrl,
}: {
  label?: string;
  onFile?: (file: File, preview: string) => void;
  previewUrl?: string | null;
}) {
  const [localPreview, setLocalPreview] = useState<string | null>(previewUrl || null);

  const handleFiles = (files: FileList | null) => {
    if (!files || !files[0]) return;
    const f = files[0];
    const url = URL.createObjectURL(f);
    setLocalPreview(url);
    onFile?.(f, url);
  };

  return (
    <div
      className="dropzone"
      tabIndex={0}
      role="button"
      aria-label={label}
      onClick={() => document.getElementById('dz-input')?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('dz-input')?.click(); } }}
      onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
      onDragOver={(e) => e.preventDefault()}
    >
      <input
        id="dz-input"
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <span className="ic" />
      <span>{label}</span>
      {(localPreview || previewUrl) && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>Предпросмотр добавлен (загрузка stub)</div>
      )}
    </div>
  );
}
