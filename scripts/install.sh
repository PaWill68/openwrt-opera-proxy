#!/bin/sh
# Установка opera-proxy + LuCI + русский перевод из релиза GitHub.
# Сам определяет менеджер пакетов (opkg -> .ipk, apk -> .apk) и архитектуру роутера.
#
#   uclient-fetch -q -O - https://raw.githubusercontent.com/PaWill68/openwrt-opera-proxy/master/scripts/install.sh | sh
#
# Параметры (переменные окружения):
#   TAG=v1.30.0-2    конкретный релиз (по умолчанию: последний)
#   LANGS="ru"       языки перевода через пробел; LANGS="" -- без перевода
#   WITH_LUCI=0      только бинарник и сервис, без веб-интерфейса
#   REPO=владелец/репозиторий   откуда брать релизы
#   PKG_ARCH=<арх>   принудительно указать архитектуру пакетов (см. opkg print-architecture)
# Пример:  uclient-fetch -q -O - <URL> | TAG=v1.30.0-2 WITH_LUCI=0 sh
set -u

REPO="${REPO:-PaWill68/openwrt-opera-proxy}"
TAG="${TAG:-latest}"
LANGS="${LANGS-ru}"
WITH_LUCI="${WITH_LUCI:-1}"
WORKDIR=/tmp/opera-proxy-install

say()  { printf '%s\n' "$*"; }
warn() { printf 'Внимание: %s\n' "$*" >&2; }
die()  { printf 'Ошибка: %s\n' "$*" >&2; rm -rf "$WORKDIR"; exit 1; }

# fetch URL [ФАЙЛ] -- без ФАЙЛА пишет в stdout
fetch() {
    if command -v uclient-fetch >/dev/null 2>&1; then
        if [ -n "${2:-}" ]; then uclient-fetch -q -O "$2" "$1"; else uclient-fetch -q -O - "$1"; fi
    elif command -v wget >/dev/null 2>&1; then
        if [ -n "${2:-}" ]; then wget -q -O "$2" "$1"; else wget -q -O - "$1"; fi
    elif command -v curl >/dev/null 2>&1; then
        if [ -n "${2:-}" ]; then curl -fsSL -o "$2" "$1"; else curl -fsSL "$1"; fi
    else
        die "нужен один из загрузчиков: uclient-fetch, wget или curl"
    fi
}

# Загрузчик нужен сразу: die внутри $(...) завершает только подоболочку, поэтому проверяем заранее.
command -v uclient-fetch >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || command -v curl >/dev/null 2>&1 \
    || die "нужен один из загрузчиков: uclient-fetch, wget или curl"

# --- менеджер пакетов ---------------------------------------------------------------
if command -v apk >/dev/null 2>&1; then
    PM=apk
    EXT=apk
elif command -v opkg >/dev/null 2>&1; then
    PM=opkg
    EXT=ipk
else
    die "не найден ни opkg, ни apk -- это точно OpenWrt?"
fi

# --- архитектура пакетов -------------------------------------------------------------
# Кандидаты перебираются по порядку, берётся первый, для которого в релизе есть пакет:
#  1. PKG_ARCH, если задана вручную (например PKG_ARCH=aarch64_cortex-a53);
#  2. DISTRIB_ARCH из /etc/openwrt_release -- архитектура, под которую собраны пакеты прошивки;
#  3. что сообщает менеджер пакетов: opkg -- все архитектуры от самой приоритетной (кроме all/noarch),
#     apk -- apk --print-arch. Это запасной путь для прошивок без DISTRIB_ARCH.
ARCHS=$(
    printf '%s\n' "${PKG_ARCH:-}"
    ( . /etc/openwrt_release 2>/dev/null; printf '%s\n' "${DISTRIB_ARCH:-}" )
    if [ "$PM" = opkg ]; then
        opkg print-architecture 2>/dev/null \
            | awk '$1 == "arch" && $2 != "all" && $2 != "noarch" { print $3, $2 }' | sort -rn | awk '{ print $2 }'
    else
        apk --print-arch 2>/dev/null
    fi
)
# убрать пустые строки и повторы, сохранив порядок
ARCHS=$(printf '%s\n' "$ARCHS" | awk 'NF && !seen[$0]++')
[ -n "$ARCHS" ] || die "не удалось определить архитектуру пакетов (нет DISTRIB_ARCH в /etc/openwrt_release и менеджер пакетов её не сообщил). Укажите вручную: PKG_ARCH=<архитектура>"
say "Менеджер пакетов: $PM (.$EXT), архитектура пакетов: $(printf '%s' "$ARCHS" | tr '\n' ' ')"

# --- список файлов релиза -----------------------------------------------------------
if [ "$TAG" = latest ]; then
    API="https://api.github.com/repos/$REPO/releases/latest"
else
    API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi
JSON=$(fetch "$API") || die "не удалось получить описание релиза: $API"
URLS=$(printf '%s\n' "$JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https:[^"]*\)"$/\1/' | grep "\\.$EXT\$")
[ -n "$URLS" ] || die "в релизе нет файлов .$EXT (проверьте REPO/TAG; возможно, исчерпан лимит запросов GitHub API -- повторите позже)"

# pick РЕГУЛЯРНОЕ_ВЫРАЖЕНИЕ -- первый URL, имя файла которого подходит
pick() { printf '%s\n' "$URLS" | grep -E "/$1\$" | head -n 1; }

# Имена: ipk -- name_версия_арх.ipk, apk -- name-версия_арх.apk (см. scripts/collect-packages.sh)
if [ "$PM" = opkg ]; then SEP='_'; else SEP='-[0-9]'; fi
BIN=""
for a in $ARCHS; do
    BIN=$(pick "opera-proxy${SEP}[^/]*_${a}\\.$EXT")
    [ -n "$BIN" ] && { ARCH=$a; break; }
done
if [ -z "$BIN" ]; then
    # версия не содержит '_', поэтому архитектура -- всё после первого '_' за версией
    AVAIL=$(printf '%s\n' "$URLS" | sed -n "s#.*/opera-proxy[_-][0-9][^_/]*_\\(.*\\)\\.$EXT\$#\\1#p" | sort -u | tr '\n' ' ')
    die "в релизе нет пакета для вашей архитектуры ($(printf '%s' "$ARCHS" | tr '\n' ' ')). Есть для: ${AVAIL:-?}"
fi

LIST="$BIN"
if [ "$WITH_LUCI" = 1 ]; then
    LUCI=$(pick "luci-app-opera-proxy${SEP}[^/]*_all\\.$EXT")
    [ -n "$LUCI" ] || die "в релизе нет luci-app-opera-proxy"
    LIST="$LIST $LUCI"
    for l in $LANGS; do
        TR=$(pick "luci-i18n-opera-proxy-${l}${SEP}[^/]*_all\\.$EXT")
        if [ -n "$TR" ]; then LIST="$LIST $TR"; else warn "перевод '$l' в релизе не найден -- пропускаю"; fi
    done
fi

# --- загрузка и установка -----------------------------------------------------------
rm -rf "$WORKDIR"; mkdir -p "$WORKDIR" || die "не удалось создать $WORKDIR"
FILES=""
for u in $LIST; do
    f="$WORKDIR/${u##*/}"
    say "Загрузка: ${u##*/}"
    fetch "$u" "$f" || die "не удалось скачать $u"
    [ -s "$f" ] || die "скачан пустой файл: ${u##*/}"
    FILES="$FILES $f"
done

say "Установка ($PM)..."
if [ "$PM" = opkg ]; then
    opkg update >/dev/null 2>&1 || warn "opkg update не удался -- зависимости могут не установиться"
    # shellcheck disable=SC2086
    opkg install $FILES || die "opkg install завершился с ошибкой"
else
    apk update >/dev/null 2>&1 || warn "apk update не удался -- зависимости могут не установиться"
    # Пакеты не подписаны ключом репозитория.
    # shellcheck disable=SC2086
    apk add --allow-untrusted $FILES || die "apk add завершился с ошибкой"
fi

rm -rf "$WORKDIR"

# Менеджер пакетов проверяет только имя архитектуры в метаданных, а не то, что процессор
# действительно умеет выполнять бинарник -- поэтому запускаем его сами.
VERSION_OUT=$(/usr/bin/opera-proxy -version 2>&1); RC=$?
if [ "$RC" -ne 0 ] || [ -z "$VERSION_OUT" ]; then
    warn "установленный /usr/bin/opera-proxy не запускается (код $RC): ${VERSION_OUT:-нет вывода}"
    warn "вероятно, архитектура пакета (${ARCH}) не подходит этому устройству. Проверьте: opkg print-architecture / cat /etc/openwrt_release"
    warn "удалить: opkg remove opera-proxy (или apk del opera-proxy)"
    exit 1
fi

say ""
say "Готово: opera-proxy $(printf '%s\n' "$VERSION_OUT" | head -n 1) (${ARCH}) установлен."
[ "$WITH_LUCI" = 1 ] && say "Веб-интерфейс: LuCI -> Службы -> Opera Proxy (при необходимости обновите страницу через Ctrl+F5)."
say "Статус службы: /etc/init.d/opera-proxy status"
