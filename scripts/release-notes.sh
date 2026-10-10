#!/usr/bin/env bash
# Печатает текст релиза (Markdown):  release-notes.sh <версия> <ревизия> <тег upstream>
set -euo pipefail
ver="$1"; rel="$2"; up="$3"
cat << 'EOF2' | sed -e "s|@VER@|$ver|g" -e "s|@REL@|$rel|g" -e "s|@UP@|$up|g"
Пакеты opera-proxy **@VER@-r@REL@** (бинарник собран из [Alexey71/opera-proxy](https://github.com/Alexey71/opera-proxy) @UP@).

| Файл | Что это | Архитектура |
|---|---|---|
| `opera-proxy_*` / `opera-proxy-*` | бинарник, init-скрипт, `/etc/config/opera-proxy` | **своя для каждой архитектуры** |
| `luci-app-opera-proxy_*` | веб-интерфейс LuCI | `all` |
| `luci-i18n-opera-proxy-ru_*` | русская локализация | `all` |

`.ipk` -- для OpenWrt 24.10 (opkg), `.apk` -- для OpenWrt 25.12 (apk).

### Какую архитектуру выбрать

    opkg print-architecture      # OpenWrt 24.10: берите последнюю строку, не `all`
    apk --print-arch             # OpenWrt 25.12

### Установка (OpenWrt 24.10, opkg)

    opkg update
    opkg install /tmp/opera-proxy_*_<АРХИТЕКТУРА>.ipk /tmp/luci-app-opera-proxy_*.ipk /tmp/luci-i18n-opera-proxy-ru_*.ipk

### Установка (OpenWrt 25.12, apk)

Пакеты не подписаны ключом репозитория, поэтому нужен `--allow-untrusted`:

    apk update
    apk add --allow-untrusted /tmp/opera-proxy-*_<АРХИТЕКТУРА>.apk /tmp/luci-app-opera-proxy-*_all.apk /tmp/luci-i18n-opera-proxy-ru-*_all.apk

После установки откройте LuCI -> Службы -> Opera Proxy. Если вы раньше ставили пакет `opera-proxy` из другого репозитория, учтите: формат
конфигурации здесь другой (`config service 'main'`), старые секции `instance` игнорируются.

Контрольные суммы: `SHA256SUMS`.
EOF2
