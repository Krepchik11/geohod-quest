'use client';
import AdminHeader from '../../AdminHeader';
import React, { useState } from 'react';

/** Gallery stub - design exact (upload btn, file rows with thumb + url + copy (state) + delete) */
export default function GalleryPage() {
  const [files, setFiles] = useState([
    { url: 'https://s3.../cannon.jpg', thumb: '/assets/img/church.jpg' },
    { url: 'https://s3.../cannon.jpg', thumb: '/assets/img/church.jpg' },
  ]);
  const [copied, setCopied] = useState<number | null>(null);

  const copy = (i: number, url: string) => {
    navigator.clipboard?.writeText(url);
    setCopied(i);
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="admin">
      <AdminHeader active="galereya" />
      <main className="container">
        <div className="up-head">
          <h1>Загрузка изображений</h1>
          <p className="helper">Нажмите на кнопку ниже, чтобы загрузить фото или видео для квеста:</p>
          <button className="btn-ui">Загрузить файл</button>
        </div>
        <h2 className="h-label files-title">Загруженные файлы:</h2>
        {files.map((f, i) => (
          <div key={i} className="file-row">
            <img className="file-row__thumb" src={f.thumb} alt="" />
            <span className="file-row__url">{f.url}</span>
            <button className={`btn-ui copy-btn ${copied === i ? 'is-copied' : ''}`} onClick={() => copy(i, f.url)}>
              {copied === i ? 'Ссылка скопирована' : 'Скопировать ссылку'}
            </button>
            <button className="btn-ui btn-ui--ghost-danger" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}>Удалить</button>
          </div>
        ))}
      </main>
    </div>
  );
}
