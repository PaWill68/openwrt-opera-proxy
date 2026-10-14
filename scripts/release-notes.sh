#!/usr/bin/env bash
# Печатает текст релиза (Markdown):  release-notes.sh <версия> <ревизия> <тег upstream>
set -euo pipefail
ver="$1"; rel="$2"; up="$3"
cat << 'EOF2' | sed -e "s|@VER@|$ver|g" -e "s|@REL@|$rel|g" -e "s|@UP@|$up|g"
Пакеты opera-proxy **@VER@-r@REL@** (бинарник собран из [Alexey71/opera-proxy](https://github.com/Alexey71/opera-proxy) @UP@).

После установки откройте LuCI -> Службы -> Opera Proxy. Если вы раньше ставили пакет `opera-proxy` из другого репозитория, учитывайте, что формат конфигурации в /etc/config/opera-proxy  и init-файл /etc/init.d/opera-proxy здесь другие. Рекомендуется удалить предыдущую установку полностью.

Контрольные суммы: `SHA256SUMS`.

EOF2
