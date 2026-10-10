# openwrt-opera-proxy

Пакеты для OpenWrt: [opera-proxy](https://github.com/Alexey71/opera-proxy) (локальный HTTP/SOCKS5-прокси через Opera VPN),
веб-интерфейс LuCI и русская локализация. Всё собирается автоматически в GitHub Actions.

| Пакет | Содержимое | Архитектура |
|---|---|---|
| `opera-proxy` | бинарник, init-скрипт, `/etc/config/opera-proxy` | своя для каждой архитектуры |
| `luci-app-opera-proxy` | LuCI: состояние и управление, настройки, диагностика | `all` |
| `luci-i18n-opera-proxy-ru` | русский перевод интерфейса | `all` |

Форматы: **`.ipk`** — OpenWrt 24.10 (opkg), **`.apk`** — OpenWrt 25.12 (apk).
Архитектуры по умолчанию: `mipsel_24kc`, `mips_24kc`, `arm_cortex-a7_neon-vfpv4`, `aarch64_cortex-a53`, `x86_64`.

## Установка

Готовые пакеты — на странице [Releases](../../releases). Нужную архитектуру роутера покажет:

    opkg print-architecture      # OpenWrt 24.10 (берите самую приоритетную строку, не all)
    apk --print-arch             # OpenWrt 25.12

OpenWrt 24.10:

    opkg update
    opkg install /tmp/opera-proxy_*_<АРХИТЕКТУРА>.ipk /tmp/luci-app-opera-proxy_*.ipk /tmp/luci-i18n-opera-proxy-ru_*.ipk

OpenWrt 25.12 (пакеты не подписаны ключом репозитория):

    apk update
    apk add --allow-untrusted /tmp/opera-proxy-*_<АРХИТЕКТУРА>.apk /tmp/luci-app-opera-proxy-*_all.apk /tmp/luci-i18n-opera-proxy-ru-*_all.apk

Дальше: LuCI → Службы → Opera Proxy. Русский язык включается в Система → Система → Язык и стиль.

> Формат конфигурации — `config service 'main'` с необязательными опциями (пустая опция = флаг не передаётся, бинарник
> использует своё значение по умолчанию). Он **не совместим** с пакетами, где конфиг устроен через секции `instance`:
> такие секции игнорируются.

## Как это устроено

    .github/workflows/build.yml      сборка и релиз
    opera-proxy/                     пакет: Makefile + files/ (init, config); бинарник кладёт CI в bin/
    luci-app-opera-proxy/            LuCI-приложение в раскладке luci.mk: htdocs/ (JS), root/ (меню, ACL), po/ (перевод)
    tools/i18n.py                    извлечение строк, слияние с .po, проверка, локальная сборка .lmo
    scripts/                         lint.sh, collect-packages.sh, release-notes.sh

Конвейер `build.yml`:

1. **lint** — `scripts/lint.sh` (синтаксис shell/JSON/JS, прогон JS через настоящий `jsmin`, проверка перевода).
2. **prepare** — версия upstream и номер ревизии пакета.
3. **binary** — бинарник собирается из исходников Alexey71/opera-proxy (`CGO_ENABLED=0`, `-trimpath`, `-s -w`,
   `-X main.version=<тег>`) под каждую архитектуру; для `x86_64` проверяется, что `-version` совпадает с тегом;
   для mips/arm бинарник сжимается UPX (≈10 МБ → ≈2,5 МБ).
4. **package** — [openwrt/gh-action-sdk](https://github.com/openwrt/gh-action-sdk) упаковывает всё в `.ipk` (SDK 24.10) и
   `.apk` (SDK 25.12). Перевод `luci-i18n-opera-proxy-ru` `luci.mk` делает сам из `po/ru/opera-proxy.po`.
5. **release** — файлы и `SHA256SUMS` публикуются в GitHub Release.

## Выпуск релиза

Тег `vX.Y.Z` (X.Y.Z — версия upstream) или `vX.Y.Z-N` (N — ревизия пакета, если меняли только наш код):

    git tag v1.30.0
    git push origin v1.30.0

Либо вручную: **Actions → Build packages → Run workflow** (можно указать версию upstream, ревизию, режим UPX и
нужно ли публиковать релиз; без публикации пакеты остаются артефактами запуска).

## Разработка

    bash scripts/lint.sh                  # все проверки (нужны bash, python3, node; для jsmin — cc и интернет)
    python3 tools/i18n.py all             # обновить .pot/.po, проверить, собрать dist/i18n/*.lmo

Правила для строк и перевода: все видимые пользователю строки — `_('...')`, подстановки через `.format()`, без пробелов
по краям строки. `lint.sh` проверяет, что `.pot`/`.po` синхронны с кодом: после правки строк выполните
`python3 tools/i18n.py update` и закоммитьте изменения в `luci-app-opera-proxy/po/`.

**Регулярки в JS.** При сборке `luci.mk` прогоняет JS через `jsmin`. Он не распознаёт литерал регулярки после `return`
(и `typeof`, `case`): если внутри есть кавычка, код портится. Поэтому пишите `return (/.../).test(x)` — `lint.sh` это проверяет.

### Добавить архитектуру

Добавьте строку в матрицу `binary` (`arch`, `goarch`, `gomips`/`goarm`, `upx`) и то же значение `arch` в матрицу `package`.
`arch` должен совпадать с архитектурой пакетов OpenWrt. Для Go: `mipsel_24kc` → `GOARCH=mipsle GOMIPS=softfloat`,
`aarch64_*` → `arm64`, `arm_cortex-a7/a9/a15…` → `arm` + `GOARM=7`, `x86_64` → `amd64`.

### Добавить язык

Создайте `luci-app-opera-proxy/po/<код>/opera-proxy.po` с заголовком (`Language:`, `Plural-Forms:` — как в `po/ru/`) и выполните
`python3 tools/i18n.py all`. `luci.mk` сам соберёт пакет `luci-i18n-opera-proxy-<код>`.

## Если первая сборка упала

| Симптом | Причина и что делать |
|---|---|
| `package`: образ `openwrt/sdk:<arch>-openwrt-25.12` не найден | в матрице `package` замените `sdk: "openwrt-25.12"` на точную версию (например `"25.12.0"`) |
| `binary`: «версия бинарника … не содержит …» | переменная версии в upstream называется не `main.version` — поправьте `-ldflags` в шаге «Сборка» |
| `binary`: ошибка `go.mod requires go >= …` | обновите `actions/setup-go` или укажите нужную версию в `go-version` |
| `package`: нет `luci.mk` / `po2lmo` | проверьте, что в SDK подключён фид `luci` (по умолчанию да) |
| `package`: «пакет … не собран» | смотрите лог шага «OpenWrt SDK» (`V=s`): обычно ошибка в Makefile |
| `.apk` не ставится | нужен `apk add --allow-untrusted …` |

## Лицензия

Выберите лицензию при создании репозитория. В `Makefile` указано `PKG_LICENSE:=MIT` (как у upstream-проекта) —
при другой лицензии поправьте оба `Makefile`.
