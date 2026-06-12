// GEOHOD QUEST — экраны коммерции (чекаут, купоны, результаты, точки входа).
// Визуальный язык витрины: tokens из design/ (синий, Inter+Jost, pill, r18).

const CO_QUEST = {
  title: "Ирония Судьбы: по следам исторических личностей",
  city: "Нови Сад, Сербия",
  duration: "1.5 часа",
  price: 300,
  author: "Сергей Шестак",
  photo: "assets/img/quest-card.png",
  avatar: "assets/img/avatar-author.jpg",
};

/* ---------- Мелочи ---------- */
function SCheckIcon({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="4,12.5 10,18.5 20,6.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"></polyline>
    </svg>
  );
}
function SCrossIcon({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"></line>
      <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"></line>
    </svg>
  );
}
function McMark() {
  return (
    <svg className="pay" width="34" height="22" viewBox="0 0 34 22" aria-hidden="true">
      <circle cx="13" cy="11" r="9" fill="#EB001B" opacity="0.9"></circle>
      <circle cx="21" cy="11" r="9" fill="#F79E1B" opacity="0.9"></circle>
    </svg>
  );
}
function PayRow() {
  return (
    <div className="co-pays">
      <span className="note">Способы оплаты</span>
      <img src="assets/icons/pay-visa--brand.svg" alt="Visa"></img>
      <McMark></McMark>
      <img src="assets/icons/pay-paypal--brand.svg" alt="PayPal"></img>
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="s-head">
      <span className="s-logo"><span className="mark"></span><span className="text"></span></span>
      <nav className="s-nav">
        <a href="#">главная</a>
        <a href="#" className="active">магазин квестов</a>
        <a href="#">мои квесты</a>
        <a href="#">контакты</a>
      </nav>
      <span className="s-head__right">
        <span className="display" style={{ fontSize: "12px" }}>ру</span>
        <span className="s-avatar"><span className="head"></span><span className="body"></span></span>
      </span>
    </header>
  );
}

function QuestSummary() {
  return (
    <div>
      <div className="s-card co-quest">
        <div className="co-quest__photo" style={{ backgroundImage: `url('${CO_QUEST.photo}')` }}>
          <span className="qmark">?</span>
        </div>
        <div className="co-quest__body">
          <p className="co-quest__meta">
            <span><span className="ic" style={{ backgroundImage: "url('assets/icons/ic-pin--navy.svg')" }}></span>{CO_QUEST.city}</span>
            <span><span className="ic" style={{ backgroundImage: "url('assets/icons/ic-clock-ring--navy.svg')" }}></span>{CO_QUEST.duration}</span>
          </p>
          <h3>{CO_QUEST.title}</h3>
          <p className="co-quest__author"><img src={CO_QUEST.avatar} alt=""></img>автор: {CO_QUEST.author}</p>
        </div>
      </div>
      <div className="co-life">
        <span style={{ color: "var(--blue)", marginTop: "1px" }}><SCheckIcon size={16}></SCheckIcon></span>
        <span><b>Покупается один раз — остаётся навсегда.</b> Проходите когда угодно, число попыток не ограничено, прогресс сохраняется. Новые версии квеста — без доплат.</span>
      </div>
    </div>
  );
}

/* ---------- Блок заказа ----------
   couponUi: 'collapsed' | 'open' | 'applied' | 'error'
   percent: 0 | 50 | 100  */
function OrderCard({ couponUi, percent = 0, code = "GEO50", interactive, io }) {
  const price = CO_QUEST.price;
  const discount = Math.round(price * percent / 100);
  const total = price - discount;
  const i = io || {};
  return (
    <div className="s-card co-order">
      <h4>Ваш заказ</h4>
      <div className="co-row"><span className="lbl">Квест</span><span>{price} ₽</span></div>
      {percent > 0 ? (
        <div className="co-row co-row--discount"><span className="lbl">Купон {code} (−{percent}%)</span><span>−{discount} ₽</span></div>
      ) : null}

      {couponUi === "collapsed" ? (
        <button className="s-link" style={{ alignSelf: "flex-start" }} type="button" onClick={i.openCoupon}>Есть купон?</button>
      ) : null}
      {couponUi === "open" || couponUi === "error" ? (
        <div>
          <div className="co-coupon">
            <input
              className={"s-input" + (couponUi === "error" ? " s-input--error" : "")}
              placeholder="Код купона"
              value={interactive ? i.couponValue : (couponUi === "error" ? "GE0-50" : "")}
              onChange={i.couponChange || (() => {})}
              onKeyDown={(e) => { if (e.key === "Enter" && i.applyCoupon) i.applyCoupon(); }}
            ></input>
            <button className="s-btn" type="button" onClick={i.applyCoupon}>Применить</button>
          </div>
          {couponUi === "error" ? <p className="s-error"><SCrossIcon size={13}></SCrossIcon>Купон не найден или истёк</p> : null}
        </div>
      ) : null}
      {couponUi === "applied" ? (
        <div className="co-applied">
          <span>Купон {code} применён · −{percent}%</span>
          <button className="s-link" type="button" onClick={i.removeCoupon}>убрать</button>
        </div>
      ) : null}

      <div className="co-divider"></div>
      <div className="co-total">
        <span className="lbl">Итого</span>
        <b>{percent > 0 ? <span className="was">{price} ₽</span> : null}{total} ₽</b>
      </div>
      <button className="s-btn s-btn--block" type="button" onClick={i.pay}>
        {total === 0 ? "Получить бесплатно" : `Оплатить ${total} ₽`}
      </button>
      {total === 0 ? (
        <p className="co-secure">Купон покрывает полную стоимость — оплата не потребуется. Квест сразу появится в «Моих квестах».</p>
      ) : (
        <React.Fragment>
          <PayRow></PayRow>
          <p className="co-secure">Оплата на защищённой странице платёжного провайдера. После оплаты вы вернётесь сюда — квест уже будет в коллекции.</p>
        </React.Fragment>
      )}
    </div>
  );
}

function CheckoutFrame({ children }) {
  return (
    <div className="site" style={{ width: "1240px", minHeight: "780px" }}>
      <SiteHeader></SiteHeader>
      <div className="co-wrap">
        <h2 className="co-title">Оформление</h2>
        <p className="co-sub">Шаг 1 из 2 — подтверждение заказа. Шаг 2 — оплата у провайдера.</p>
        <div className="co-cols">
          <QuestSummary></QuestSummary>
          {children}
        </div>
      </div>
    </div>
  );
}

/* Статичные варианты чекаута */
function CheckoutBase()    { return <CheckoutFrame><OrderCard couponUi="collapsed"></OrderCard></CheckoutFrame>; }
function CheckoutApplied() { return <CheckoutFrame><OrderCard couponUi="applied" percent={50} code="GEO50"></OrderCard></CheckoutFrame>; }
function CheckoutFree()    { return <CheckoutFrame><OrderCard couponUi="applied" percent={100} code="GEOFREE"></OrderCard></CheckoutFrame>; }
function CheckoutError()   { return <CheckoutFrame><OrderCard couponUi="error"></OrderCard></CheckoutFrame>; }

/* ---------- Результаты ---------- */
function SuccessScreen() {
  return (
    <div className="site" style={{ width: "1240px", minHeight: "700px" }}>
      <SiteHeader></SiteHeader>
      <div className="res-wrap">
        <div className="s-card res-card">
          <span className="res-icon"><SCheckIcon></SCheckIcon></span>
          <h2>Квест ваш — навсегда</h2>
          <p>«{CO_QUEST.title}» добавлен в вашу коллекцию. Доступ бессрочный: проходите, сбрасывайте, возвращайтесь.</p>
          <div className="res-details">
            <div className="co-row"><span className="lbl">Заказ</span><span>№ 2026-0611-184</span></div>
            <div className="co-row"><span className="lbl">Оплачено</span><span>150 ₽ · Visa ···· 4242</span></div>
            <div className="co-row"><span className="lbl">Купон</span><span>GEO50 (−50%)</span></div>
          </div>
          <div className="res-actions">
            <button className="s-btn" type="button">Начать квест</button>
            <button className="s-btn s-btn--outline" type="button">В мои квесты</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FailScreen() {
  return (
    <div className="site" style={{ width: "1240px", minHeight: "700px" }}>
      <SiteHeader></SiteHeader>
      <div className="res-wrap">
        <div className="s-card res-card">
          <span className="res-icon res-icon--fail"><SCrossIcon></SCrossIcon></span>
          <h2>Оплата не прошла</h2>
          <p>Банк отклонил операцию — деньги не списаны. Попробуйте ещё раз или выберите другой способ оплаты.</p>
          <div className="res-actions">
            <button className="s-btn" type="button">Попробовать снова</button>
            <button className="s-btn s-btn--outline" type="button">Вернуться к квесту</button>
          </div>
          <p style={{ fontSize: "12px" }}>Не получается? Напишите нам: geoquest@gmail.com</p>
        </div>
      </div>
    </div>
  );
}

/* ---------- Вход перед покупкой ---------- */
function AuthGateScreen() {
  return (
    <div className="site" style={{ width: "1240px", minHeight: "700px" }}>
      <SiteHeader></SiteHeader>
      <div className="res-wrap">
        <div className="s-card auth-card">
          <h2>Вход через Телеграм</h2>
          <div className="auth-ctx">
            <span style={{ color: "var(--blue)", marginTop: "1px" }}><SCheckIcon size={15}></SCheckIcon></span>
            <span>Квест закрепляется за вашим аккаунтом навсегда — поэтому сначала вход. После входа вернём вас к оформлению «{CO_QUEST.title.slice(0, 14)}…»</span>
          </div>
          <label className="auth-consent">
            <input type="checkbox" defaultChecked></input>
            <span>Согласен с <a className="s-link" href="#">пользовательским соглашением</a> и <a className="s-link" href="#">политикой конфиденциальности</a></span>
          </label>
          <button className="s-btn s-btn--block" type="button"><span className="ic-tg"></span>Войти через Телеграм</button>
          <p style={{ fontSize: "12px", color: "var(--gray)", textAlign: "center", margin: 0 }}>Откроется бот @geohod_bot — подтвердите вход одним нажатием</p>
        </div>
      </div>
    </div>
  );
}

/* ---------- Точки входа на странице квеста ---------- */
function EntryCard({ variant }) {
  return (
    <div className="site" style={{ width: "420px", padding: "24px", background: "var(--bg-light)" }}>
      <div className="s-card entry-card">
        {variant === "paid" ? (
          <React.Fragment>
            <div className="entry-price"><span className="lbl">Цена:</span><b>300 ₽</b></div>
            <button className="s-btn" type="button">Купить</button>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--gray)" }}>Покупка одним платежом · доступ навсегда</p>
          </React.Fragment>
        ) : null}
        {variant === "free" ? (
          <React.Fragment>
            <div className="entry-price"><span className="lbl">Цена:</span><b className="free">Бесплатно</b></div>
            <button className="s-btn" type="button">Получить бесплатно</button>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--gray)" }}>Без оплаты — квест сразу в коллекции</p>
          </React.Fragment>
        ) : null}
        {variant === "owned" ? (
          <React.Fragment>
            <p className="entry-owned"><SCheckIcon size={16}></SCheckIcon>Квест в вашей коллекции</p>
            <button className="s-btn" type="button">Открыть квест</button>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--gray)" }}>Куплен 11.06.2026 · доступ бессрочный</p>
          </React.Fragment>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- Мобильный чекаут (360) ---------- */
function MobileCheckout() {
  return (
    <div className="site m-site">
      <div className="s-head">
        <button className="m-burger" type="button" aria-label="Меню"><span></span><span></span><span></span></button>
        <span className="s-logo"><span className="mark"></span><span className="text"></span></span>
        <span className="s-avatar" style={{ width: "36px", height: "36px" }}><span className="head"></span><span className="body"></span></span>
      </div>
      <div className="m-co">
        <h2 className="co-title" style={{ fontSize: "17px" }}>Оформление</h2>
        <div className="s-card co-quest">
          <div className="co-quest__photo" style={{ backgroundImage: `url('${CO_QUEST.photo}')` }}><span className="qmark" style={{ fontSize: "26px" }}>?</span></div>
          <div className="co-quest__body">
            <h3>{CO_QUEST.title}</h3>
            <p className="co-quest__meta"><span>{CO_QUEST.city}</span></p>
          </div>
        </div>
        <OrderCard couponUi="collapsed"></OrderCard>
      </div>
    </div>
  );
}

function MobileSuccess() {
  return (
    <div className="site m-site">
      <div className="s-head">
        <button className="m-burger" type="button" aria-label="Меню"><span></span><span></span><span></span></button>
        <span className="s-logo"><span className="mark"></span><span className="text"></span></span>
        <span className="s-avatar" style={{ width: "36px", height: "36px" }}><span className="head"></span><span className="body"></span></span>
      </div>
      <div className="m-co" style={{ justifyContent: "center" }}>
        <div className="s-card res-card" style={{ width: "100%", padding: "32px 24px" }}>
          <span className="res-icon"><SCheckIcon></SCheckIcon></span>
          <h2 style={{ fontSize: "18px" }}>Квест ваш — навсегда</h2>
          <p style={{ fontSize: "13px" }}>Добавлен в коллекцию. Скачайте квест заранее — он работает без интернета.</p>
          <div className="res-actions" style={{ flexDirection: "column", width: "100%" }}>
            <button className="s-btn s-btn--block" type="button">Начать квест</button>
            <button className="s-btn s-btn--outline s-btn--block" type="button">В мои квесты</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Играбельный прототип чекаута ----------
   Купоны: GEO50 (−50%), GEOFREE (−100%). Оплата → оверлей → успех. */
function CheckoutProto() {
  const [stage, setStage] = React.useState("checkout"); // checkout | paying | success
  const [couponUi, setCouponUi] = React.useState("collapsed");
  const [couponValue, setCouponValue] = React.useState("");
  const [percent, setPercent] = React.useState(0);
  const [code, setCode] = React.useState("");

  const io = {
    openCoupon: () => setCouponUi("open"),
    couponValue,
    couponChange: (e) => { setCouponValue(e.target.value); if (couponUi === "error") setCouponUi("open"); },
    applyCoupon: () => {
      const v = couponValue.trim().toUpperCase();
      if (v === "GEO50") { setPercent(50); setCode("GEO50"); setCouponUi("applied"); }
      else if (v === "GEOFREE") { setPercent(100); setCode("GEOFREE"); setCouponUi("applied"); }
      else setCouponUi("error");
    },
    removeCoupon: () => { setPercent(0); setCode(""); setCouponValue(""); setCouponUi("open"); },
    pay: () => {
      if (percent === 100) { setStage("success"); return; }
      setStage("paying");
      setTimeout(() => setStage("success"), 1600);
    },
  };

  if (stage === "success") {
    return (
      <div style={{ position: "relative" }}>
        <SuccessScreen></SuccessScreen>
        <button className="s-link" type="button"
          style={{ position: "absolute", top: "16px", right: "20px" }}
          onClick={() => { setStage("checkout"); setPercent(0); setCode(""); setCouponValue(""); setCouponUi("collapsed"); }}>
          ↺ начать сначала
        </button>
      </div>
    );
  }
  return (
    <div style={{ position: "relative" }}>
      <CheckoutFrame>
        <OrderCard couponUi={couponUi} percent={percent} code={code} interactive={true} io={io}></OrderCard>
      </CheckoutFrame>
      {stage === "paying" ? (
        <div className="pay-overlay">
          <span className="spin"></span>
          <span>Переходим на страницу оплаты…</span>
          <span style={{ fontSize: "12px", opacity: .7 }}>демо: провайдер подтвердит платёж автоматически</span>
        </div>
      ) : null}
    </div>
  );
}

Object.assign(window, {
  CheckoutBase, CheckoutApplied, CheckoutFree, CheckoutError,
  SuccessScreen, FailScreen, AuthGateScreen,
  EntryCard, MobileCheckout, MobileSuccess, CheckoutProto,
});
