'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import SiteHeader from '../SiteHeader';
import { api } from '../../lib/api';
import { currentPlayerId } from '../../lib/identity';

/**
 * Оформление (чекаут) — structure, classes and RU copy ported from
 * design/commerce/screens.jsx (CheckoutBase + coupon states + Success/Fail).
 * Parameterized by ?quest=<id> (any published quest is buyable); payment is the
 * backend's mocked provider — «Оплатить» always succeeds and records the
 * payment_ref on the grant. Coupon flow: collapsed «Есть купон?» → input +
 * Применить → applied/error; 100% coupon (and free quests) flow to 0 ₽
 * «Получить бесплатно» without a provider step — one grant mechanic (SPEC).
 */

const DEFAULT_QUEST = {
  id: 'mystery-fortress-v1',
  title: 'Ирония судьбы: по следам исторических личностей',
  price: 300,
  city: 'Нови Сад',
  duration: '90 минут',
};

/** Demo coupon registry until real coupons land with the commerce phase. */
const COUPONS: Record<string, number> = { GEO50: 50, GEOFREE: 100 };

type CouponUi = 'collapsed' | 'open' | 'applied' | 'error';
type Status = 'checkout' | 'paying' | 'success' | 'fail';

interface Order {
  id: string;
  total: number;
  paidWith: string;
  coupon: string | null;
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutPageInner />
    </Suspense>
  );
}

function CheckoutPageInner() {
  const searchParams = useSearchParams();
  const questParam = searchParams.get('quest');
  const [couponUi, setCouponUi] = useState<CouponUi>('collapsed');
  const [couponCode, setCouponCode] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('checkout');
  const [order, setOrder] = useState<Order | null>(null);
  const [QUEST, setQuest] = useState(
    questParam ? { ...DEFAULT_QUEST, id: questParam, title: questParam } : DEFAULT_QUEST
  );

  // Resolve the real quest name from the published list (graceful: id as title
  // until loaded, design defaults when unreachable).
  useEffect(() => {
    if (!questParam) return;
    let cancelled = false;
    api.listQuests()
      .then((quests) => {
        const meta = quests.find((q) => q.quest_id === questParam);
        if (!cancelled && meta) setQuest((prev) => ({ ...prev, title: meta.name }));
      })
      .catch(() => { /* keep the param-derived title */ });
    return () => { cancelled = true; };
  }, [questParam]);

  const percent = appliedCode ? COUPONS[appliedCode] : 0;
  const total = Math.max(0, Math.round(QUEST.price * (1 - percent / 100)));
  const isFree = total === 0;

  const applyCoupon = () => {
    const code = couponCode.trim().toUpperCase();
    if (COUPONS[code]) {
      setAppliedCode(code);
      setCouponUi('applied');
    } else {
      setCouponUi('error');
    }
  };

  const removeCoupon = () => {
    setAppliedCode(null);
    setCouponCode('');
    setCouponUi('collapsed');
  };

  const pay = async () => {
    setStatus('paying');
    try {
      await api.checkout({ player_id: currentPlayerId(), quest_id: QUEST.id, coupon_percent: percent || undefined });
      setOrder({
        id: '2026-0611-184',
        total,
        paidWith: isFree ? '—' : 'Тестовый провайдер (mock)',
        coupon: appliedCode ? `${appliedCode} (−${percent}%)` : null,
      });
      setStatus('success');
    } catch {
      setStatus('fail');
    }
  };

  if (status === 'success' && order) {
    return (
      <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
        <SiteHeader />
        <div className="res-wrap">
          <div className="s-card res-card">
            <div className="res-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M4 12.5 9.5 18 20 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <h2>Квест ваш — навсегда</h2>
            <p>«{QUEST.title}» добавлен в вашу коллекцию. Доступ бессрочный — проходите когда удобно.</p>
            <div className="res-details">
              <div className="co-row"><span className="lbl">Заказ</span><span>№ {order.id}</span></div>
              <div className="co-row"><span className="lbl">Оплачено</span><span>{order.total} ₽ · {order.paidWith}</span></div>
              {order.coupon && <div className="co-row"><span className="lbl">Купон</span><span>{order.coupon}</span></div>}
            </div>
            <div className="res-actions">
              <Link className="s-btn" href={`/quest/${QUEST.id}`}>Начать квест</Link>
              <Link className="s-btn s-btn--outline" href="/my-quests">В мои квесты</Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'fail') {
    return (
      <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
        <SiteHeader />
        <div className="res-wrap">
          <div className="s-card res-card">
            <div className="res-icon res-icon--fail">
              <svg width="28" height="28" viewBox="0 0 24 24"><path d="M5 5 19 19 M19 5 5 19" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></svg>
            </div>
            <h2>Оплата не прошла</h2>
            <p>Банк отклонил операцию — деньги не списаны. Попробуйте ещё раз или другой способ оплаты.</p>
            <div className="res-actions">
              <button className="s-btn" type="button" onClick={() => setStatus('checkout')}>Попробовать снова</button>
              <Link className="s-btn s-btn--outline" href="/quest-detail">Вернуться к квесту</Link>
            </div>
            <p>Не получается? Напишите нам: geoquest@gmail.com</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="site min-h-screen" style={{ background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader />
      <main className="co-wrap">
        <h2 className="co-title">Оформление</h2>
        <p className="co-sub">Шаг 1 из 2 — подтверждение заказа. Шаг 2 — оплата у провайдера.</p>

        <div className="co-cols">
          {/* Квест */}
          <div>
            <div className="s-card co-quest">
              <div className="co-quest__photo" style={{ backgroundImage: 'url(/assets/img/quest-card.png)', backgroundColor: 'var(--navy)' }} />
              <div className="co-quest__body">
                <p className="co-quest__meta">
                  <span><span className="ic" style={{ backgroundImage: 'url(/assets/icons/ic-pin--navy.svg)' }} />{QUEST.city}</span>
                  <span><span className="ic" style={{ backgroundImage: 'url(/assets/icons/ic-clock-ring--navy.svg)' }} />{QUEST.duration}</span>
                </p>
                <h3>{QUEST.title}</h3>
              </div>
            </div>
            <div className="co-life">
              <svg width="16" height="16" viewBox="0 0 16 16" style={{ flex: 'none', marginTop: 2 }}><polyline points="2.5,8.5 6.5,12.5 13.5,4" fill="none" stroke="var(--green)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span><b>Покупается один раз — остаётся навсегда.</b> Проходите когда угодно, новые попытки начинаются на актуальной версии квеста.</span>
            </div>
          </div>

          {/* Заказ */}
          <div className="s-card co-order">
            <h4>Ваш заказ</h4>
            <div className="co-row"><span className="lbl">{QUEST.title}</span><span>{QUEST.price} ₽</span></div>
            {percent > 0 && (
              <div className="co-row co-row--discount"><span className="lbl">Скидка по купону</span><span>−{percent}%</span></div>
            )}

            {couponUi === 'collapsed' && (
              <button className="s-link" type="button" onClick={() => setCouponUi('open')}>Есть купон?</button>
            )}
            {(couponUi === 'open' || couponUi === 'error') && (
              <div>
                <div className="co-coupon">
                  <input
                    className={'s-input' + (couponUi === 'error' ? ' s-input--error' : '')}
                    placeholder="Код купона"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyCoupon(); }}
                  />
                  <button className="s-btn" type="button" onClick={applyCoupon}>Применить</button>
                </div>
                {couponUi === 'error' && <p className="s-error">Купон не найден или истёк</p>}
              </div>
            )}
            {couponUi === 'applied' && appliedCode && (
              <div className="co-applied">
                <span>Купон {appliedCode} применён · −{percent}%</span>
                <button className="s-link" type="button" onClick={removeCoupon}>убрать</button>
              </div>
            )}

            <div className="co-divider" />
            <div className="co-total">
              <span className="lbl">Итого</span>
              <b>{percent > 0 && <span className="was">{QUEST.price} ₽</span>}{total} ₽</b>
            </div>

            <button className="s-btn s-btn--block" type="button" disabled={status === 'paying'} onClick={pay}>
              {isFree ? 'Получить бесплатно' : `Оплатить ${total} ₽`}
            </button>

            {!isFree && (
              <div className="co-pays">
                <span className="note">Способы оплаты</span>
                <img className="pay" src="/assets/icons/pay-visa--brand.svg" alt="Visa" />
                <img className="pay" src="/assets/icons/pay-paypal--brand.svg" alt="PayPal" />
              </div>
            )}
            <p className="co-secure">
              {isFree
                ? 'Без оплаты — квест сразу появится в вашей коллекции.'
                : 'Оплата на защищённой странице платёжного провайдера. Мы не храним данные карт.'}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
