# Auth v2.dc.html — extracted notes

Card 390 r24 pad 28 24, ✕ button (32px circle bg #F1F3F7, top-right) → «/» (never history.back()).

## Step 1 (email)
h2 20/600 «Вход или регистрация»; sub 13.5 #5B6373 «Аккаунт сохранит покупки, монеты и прогресс при смене устройства.»; label «Email» 12.5/600 #5B6373; input h48 r12; primary h52 «Продолжить»; caption 12px muted centered «Играть можно и без аккаунта — вернитесь к этому позже.»

## Step 2a (exists → вход)
h2 «С возвращением!»; email chip h32 r16 bg #F1F3F7 13px + «изменить» blue; password field h48 r12 with right «Показать» 12.5 blue; right-aligned link «Забыли пароль?» 13px; primary «Войти».
Wrong password: field border 1.5px #C0395C + under-field «Неверный пароль. [Восстановить?]» 12.5 (error at field, not banner).

## Step 2b (new → регистрация)
h2 «Создадим аккаунт»; email chip + изменить; password label «Придумайте пароль», hint «Минимум 8 символов», «Показать»; consent checkbox (blue 18px square ✓) «Принимаю [пользовательское соглашение] и [политику конфиденциальности]» (real /terms /privacy); primary «Зарегистрироваться»; green box (bg rgba(31,138,91,.07) #245C43 12.5) «✓ Монеты и покупки этого устройства привяжутся к аккаунту.»

## Soft email confirmation (banner in Profile)
Amber box bg rgba(180,83,9,.08) #7A4A0B 12.5: «Подтвердите почту — отправили письмо на {email}» + outline pill h34 1px rgba(180,83,9,.35) «Отправить ещё раз». Dismissable.

## Recovery R1 link + R2 code (R3 magic-link explored & rejected)
Card 340: h3 «Восстановление пароля»; «Пришлём ссылку для смены пароля.»; prefilled email input; primary «Отправить ссылку»; «← Назад ко входу» centered muted.
Sent state: ✉ circle green; b «Письмо ушло»; «Отправили код и ссылку на an***@gmail.com — действуют 30 минут. Не пришло — проверьте „Спам".»; inline code entry «Код из письма» (6 digits, one-time-code) + «Новый пароль» + primary «Сменить пароль и войти»; quiet pill «Отправить ещё раз · 0:42» (cooldown timer).
Same «sent» response whether or not email exists (no enumeration); resend with timer, resend invalidates prior code+link (latest mail wins).
Mail: code on the first line (notification preview), link below. Link opens /auth/reset?token=… → new password (min 8, Показать) → success → signed in. Code path: POST /api/auth/reset {email, code, password} — email-scoped, 5 verify attempts max.

## Notes
- identify: POST /api/auth/identify {email}→{exists}; 409 class disappears by construction (keep defensive msg).
- Recovery trusts only CONFIRMED email; unconfirmed → explain + offer confirmation resend.
- Register still passes anonymousPlayerId() — coins/purchases attach (now stated in form).
