'use client';

import React, { useEffect, useState } from 'react';
import { api, apiErrorMessage, type CouponFunnelWire } from '../../../lib/api';
import { hasSingleQuest, qrLink, toAdminCoupon, type AdminCoupon } from '../../../lib/admin-coupons';
import { qrMatrix, qrPng, qrSvg, saveBlob, type QrMatrix } from '../../../lib/qr';
import { siteUrl } from '../../../lib/share';

/** PNG width for an office printer: a 10 cm square at 300 dpi. */
const PNG_PX = 1200;

/** The funnel's rows, in order. */
const FUNNEL_STEPS: ReadonlyArray<[keyof CouponFunnelWire, string]> = [
  ['scans', 'Сканы'],
  ['got', 'Получили квест'],
  ['started', 'Начали'],
  ['finished', 'Прошли'],
  ['rated', 'Оценили'],
  ['bought', 'Купили другой квест'],
];

/**
 * The coupon editor's «QR-код» card (flag `promo_qr`). A coupon limited to
 * one quest gets a QR invitation: the QR holds the coupon's permanent short
 * link, made once by «Сделать QR-код» and untouched by later saves — a
 * printed QR keeps working when the code is renamed. PNG for an office
 * printer, SVG for a print shop, the link itself for posts. Under it, the
 * invitation's funnel from the scan to the next purchase.
 *
 * Works from the SAVED coupon: applicability edited but not saved yet does
 * not count — the server decides on what it stores.
 */
export default function CouponQrCard({
  coupon,
  onCoupon,
  onToast,
}: {
  coupon: AdminCoupon;
  /** The coupon as the server returned it after the QR was made. */
  onCoupon: (c: AdminCoupon) => void;
  onToast: (text: string) => void;
}) {
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<QrMatrix | null>(null);
  const [funnel, setFunnel] = useState<CouponFunnelWire | null>(null);
  const single = hasSingleQuest(coupon);
  const slug = coupon.qrSlug;
  const link = slug ? qrLink(siteUrl(), slug) : null;

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    qrMatrix(link)
      .then((m) => {
        if (!cancelled) setMatrix(m);
      })
      .catch(() => {
        if (!cancelled) setError('Не удалось нарисовать QR-код — обновите страницу.');
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .adminCouponFunnel(coupon.id)
      .then((f) => {
        if (!cancelled) setFunnel(f);
      })
      .catch(() => {
        /* the QR still works; the numbers come with the next visit */
      });
    return () => {
      cancelled = true;
    };
  }, [coupon.id, slug]);

  const makeQr = async () => {
    setMaking(true);
    setError(null);
    try {
      onCoupon(toAdminCoupon(await api.adminCreateCouponQr(coupon.id)));
    } catch (err) {
      setError(apiErrorMessage(err, 'Не удалось сделать QR-код. Проверьте соединение и попробуйте ещё раз.'));
    } finally {
      setMaking(false);
    }
  };

  const svg = matrix ? qrSvg(matrix) : null;
  const fileName = `geohod-qr-${slug ?? ''}`;
  const downloadPng = () => {
    if (!matrix) return;
    qrPng(matrix, PNG_PX)
      .then((blob) => saveBlob(blob, `${fileName}.png`))
      .catch(() => onToast('Не удалось сохранить PNG'));
  };
  const downloadSvg = () => {
    if (svg) saveBlob(new Blob([svg], { type: 'image/svg+xml' }), `${fileName}.svg`);
  };
  const copyLink = () => {
    if (!link) return;
    navigator.clipboard
      .writeText(link)
      .then(() => onToast('Ссылка скопирована'))
      .catch(() => onToast('Не удалось скопировать ссылку'));
  };

  return (
    <section className="ac-card ac-card--qr">
      <div className="ac-card__label">QR-КОД</div>
      {!single ? (
        <div className={slug ? 'ac-qr-warn' : 'ac-side-note'} role={slug ? 'alert' : undefined}>
          {slug
            ? 'QR-код сейчас не работает: купон больше не на один квест. Оставьте в «Применимости» один квест и сохраните — напечатанные QR снова заработают.'
            : 'QR-код делается для купона на один квест: в «Применимости» выберите «Выбранные», один квест — и сохраните купон.'}
        </div>
      ) : !slug ? (
        <>
          <div className="ac-side-note">
            Гость наводит камеру — открывается страница квеста с «Квест в подарок» и кнопкой
            «Получить бесплатно». Лимит, срок и пауза купона действуют и для QR.
          </div>
          <button type="button" className="ac-side-btn" disabled={making} onClick={() => void makeQr()}>
            {making ? 'Делаем…' : 'Сделать QR-код'}
          </button>
        </>
      ) : (
        <>
          <div className="ac-qr">
            {svg ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL of our own SVG: the preview is the very file «Скачать SVG» saves
              <img
                className="ac-qr__img"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
                alt={`QR-код ссылки ${link}`}
              />
            ) : (
              <span className="ash-spinner" aria-label="Рисуем QR-код" />
            )}
            <code className="ac-qr__link">{link?.replace(/^https?:\/\//, '')}</code>
          </div>
          <div className="ac-qr__actions">
            <button type="button" className="ac-side-btn" disabled={!matrix} onClick={downloadPng}>
              Скачать PNG
            </button>
            <button type="button" className="ac-side-btn" disabled={!svg} onClick={downloadSvg}>
              Скачать SVG
            </button>
            <button type="button" className="ac-side-btn" onClick={copyLink}>
              Скопировать ссылку
            </button>
          </div>
          <div className="ac-side-note">
            PNG — для принтера, SVG — для типографии. Сторона QR — не меньше 1/10 расстояния, с
            которого сканируют: с метра — от 10 см. Рядом напечатайте адрес ссылки текстом — гость
            увидит, что идёт на quest.geohod.ru.
          </div>
          {funnel && (
            <div className="ac-qr__funnel">
              <div className="ac-card__label">ВОРОНКА</div>
              <div className="ac-usage-rows">
                {FUNNEL_STEPS.map(([key, label]) => (
                  <div key={key}>
                    <span>{label}</span>
                    <b>{funnel[key]}</b>
                  </div>
                ))}
              </div>
              <div className="ac-side-note">
                Сканы — без роботов и превью ссылок. «Купили» — другой платный квест в течение 30
                дней после подарка.
              </div>
            </div>
          )}
        </>
      )}
      {error && <div className="ac-form-error" role="alert">{error}</div>}
    </section>
  );
}
