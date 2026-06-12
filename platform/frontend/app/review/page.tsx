'use client';

import React from 'react';
import SiteHeader from '../SiteHeader';

/**
 * Visual regression fixture - from design/review/Визуальный контроль.html
 * Icons, headers, meta from design (logo, avatar, pay, assembled).
 * Use to check design fidelity (paper/site tokens, icons).
 */
export default function ReviewFixture() {
  return (
    <div className="site" style={{ padding: 20 }}>
      <SiteHeader />
      <h1>Визуальный контроль (design fixture)</h1>
      <p>Check icons, headers, meta, pay from design (logo, avatar composition, meta icons, pay marks, assembled headers).</p>
      <div style={{ display: 'flex', gap: 20, marginTop: 20 }}>
        <div>
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/logo-mark--navy.svg')", width: '30px', height: '27px' } as React.CSSProperties} />
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/logo-text--navy.svg')", width: '52px', height: '28px' } as React.CSSProperties} />
        </div>
        <div>
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-star-24--gold.svg')", width: '24px', height: '24px' } as React.CSSProperties} />
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-pin--navy.svg')", width: '14px', height: '14px' } as React.CSSProperties} />
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-clock-ring--navy.svg')", width: '14px', height: '14px' } as React.CSSProperties} />
        </div>
        <div>
          <span className="pay pay--visa"><span className="g" /></span>
          <span className="pay pay--mc"><span className="g" /></span>
          <span className="pay pay--pp"><span className="g" /></span>
        </div>
        <div>
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-user-head--navy.svg')", width: '24px', height: '24px' } as React.CSSProperties} />
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/ic-user-body--navy.svg')", width: '24px', height: '24px' } as React.CSSProperties} />
        </div>
      </div>

      {/* More visual control per design/review: assembled meta, avatar composite, pay row, header mock */}
      <div style={{ marginTop: 24, padding: 12, border: '1px solid #ddd', maxWidth: 520 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="ic" style={{ '--ic': "url('/assets/icons/c/logo-mark--navy.svg')", width: 22, height: 20 } as React.CSSProperties} />
          <span style={{ fontWeight: 700 }}>GEOHOD</span>
          <span style={{ opacity: 0.6 }}>· Квесты</span>
        </div>
        <div className="info-tile" style={{ marginBottom: 6 }}>
          <span className="info-tile__icon"><span className="ic-cmp ic-loc"><span className="a"></span></span></span>
          <span><b>Локация</b><small>Нови Сад</small></span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="review__avatar"><span className="user-icon"><span className="head" style={{ '--ic': "url('/assets/icons/c/ic-user-head--navy.svg')" } as React.CSSProperties}></span><span className="body" style={{ '--ic': "url('/assets/icons/c/ic-user-body--navy.svg')" } as React.CSSProperties}></span></span></span>
          <span>Сергей Шестак — автор</span>
        </div>
        <div className="payments" style={{ marginTop: 10 }}>
          <span className="pay pay--visa"><span className="g" /></span>
          <span className="pay pay--mc"><span className="g" /></span>
          <span className="pay pay--pp"><span className="g" /></span>
        </div>
      </div>
      <p className="text-xs mt-4">Visual fixture baseline (icons + composites + meta + pay). Compare vs design/review/Визуальный контроль.html</p>
    </div>
  );
}
