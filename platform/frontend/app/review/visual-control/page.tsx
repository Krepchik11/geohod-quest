/**
 * Визуальный контроль: иконография и шапки.
 * Recreates design/review/Визуальный контроль.html — the visual regression
 * baseline for logo, avatar composition (head+body centered), meta icons,
 * pay marks, telegram-on-dark and the assembled site/admin headers (1240).
 * Static RSC page; assets are the design SVGs copied AS-IS.
 */

const cellStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
};
const capStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: '#83858C',
};
const stripStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-end', gap: 28, background: '#fff',
  borderRadius: 14, padding: '20px 24px', flexWrap: 'wrap',
};

function Cell({ cap, children }: { cap: string; children: React.ReactNode }) {
  return (
    <div style={cellStyle}>
      {children}
      <span style={capStyle}>{cap}</span>
    </div>
  );
}

function Avatar({ size }: { size: number }) {
  return (
    <span className="s-avatar" style={{ width: size, height: size }}>
      <span className="head" />
      <span className="body" />
    </span>
  );
}

export default function VisualControlPage() {
  return (
    <div className="site" style={{ background: '#F1F2F5', minHeight: '100vh', padding: '32px 40px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <h1 style={{ margin: 0, fontSize: 22 }}>Визуальный контроль: иконография и шапки</h1>
      <p style={{ margin: 0, fontSize: 13, color: '#83858C' }}>
        Фикстура для проверки ассетов: контуры не обрезаны, VISA читается, фигура профиля по центру круга.
      </p>

      <h2 style={{ margin: '8px 0 0', fontSize: 16 }}>Логотип</h2>
      <div style={stripStyle}>
        <Cell cap="шапка сайта 34/60">
          <span className="s-logo"><span className="mark" /><span className="text" /></span>
        </Cell>
        <Cell cap="logo-mark ×3">
          <img src="/assets/icons/logo-mark--navy.svg" alt="" style={{ width: 90 }} />
        </Cell>
        <Cell cap="logo-text ×3">
          <img src="/assets/icons/logo-text--navy.svg" alt="" style={{ width: 150 }} />
        </Cell>
        <Cell cap="бренд админки">
          <span style={{ width: 40, height: 36, display: 'block', background: 'url(/assets/icons/logo-mark--navy.svg) no-repeat center / contain' }} />
        </Cell>
      </div>

      <h2 style={{ margin: '8px 0 0', fontSize: 16 }}>Аватар профиля</h2>
      <div style={stripStyle}>
        <Cell cap="48px (desktop)"><Avatar size={48} /></Cell>
        <Cell cap="36px (mobile)"><Avatar size={36} /></Cell>
        <Cell cap="48px ×2"><span style={{ transform: 'scale(2)', transformOrigin: 'bottom center', display: 'inline-block' }}><Avatar size={48} /></span></Cell>
      </div>

      <h2 style={{ margin: '8px 0 0', fontSize: 16 }}>Мета-иконки и оплата</h2>
      <div style={stripStyle}>
        <Cell cap="pin ×2"><img src="/assets/icons/ic-pin--navy.svg" alt="" style={{ width: 28 }} /></Cell>
        <Cell cap="clock ×2"><img src="/assets/icons/ic-clock-ring--navy.svg" alt="" style={{ width: 28 }} /></Cell>
        <Cell cap="star ×2"><img src="/assets/icons/ic-star-18--gold.svg" alt="" style={{ width: 36 }} /></Cell>
        <Cell cap="visa ×2"><img src="/assets/icons/pay-visa--brand.svg" alt="" style={{ height: 28 }} /></Cell>
        <Cell cap="paypal ×2"><img src="/assets/icons/pay-paypal--brand.svg" alt="" style={{ height: 36 }} /></Cell>
      </div>
      <div style={{ ...stripStyle, background: '#1A2B48' }}>
        <Cell cap="telegram ×2 (на тёмном)"><img src="/assets/icons/ic-telegram-plane--white.svg" alt="" style={{ width: 40 }} /></Cell>
      </div>

      <h2 style={{ margin: '8px 0 0', fontSize: 16 }}>Шапка сайта в сборе (1240)</h2>
      <div style={{ width: 1240, maxWidth: '100%', background: '#fff', borderRadius: 14, overflow: 'hidden' }}>
        <div className="s-head">
          <span className="s-logo"><span className="mark" /><span className="text" /></span>
          <nav className="s-nav">
            <a href="#">главная</a>
            <a href="#" className="active">магазин квестов</a>
            <a href="#">мои квесты</a>
            <a href="#">контакты</a>
          </nav>
          <span className="s-head__right">
            <span className="display" style={{ fontSize: 12 }}>ру</span>
            <Avatar size={48} />
          </span>
        </div>
      </div>

      <h2 style={{ margin: '8px 0 0', fontSize: 16 }}>Шапка админки в сборе (1240)</h2>
      <div className="admin" style={{ width: 1240, maxWidth: '100%', background: '#F7F8FA', borderRadius: 14, overflow: 'hidden' }}>
        <div className="adm-head">
          <span className="brand" />
          <nav className="adm-nav">
            <a href="#" className="active">Квесты</a>
            <a href="#" className="stub">Локации</a>
            <a href="#">Стат.</a>
            <a href="#">Пользователи</a>
            <a href="#">Галерея</a>
          </nav>
          <Avatar size={48} />
        </div>
      </div>
    </div>
  );
}
