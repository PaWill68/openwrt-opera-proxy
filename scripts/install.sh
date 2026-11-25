#!/bin/sh
# Установка opera-proxy + LuCI + русский перевод из релиза GitHub.
# Сам определяет менеджер пакетов (opkg -> .ipk, apk -> .apk) и архитектуру роутера.
#
#   curl -fsSL https://raw.githubusercontent.com/PaWill68/openwrt-opera-proxy/master/scripts/install.sh | sh
#
# Параметры (переменные окружения):
#   TAG=v1.30.0-2       конкретный релиз (по умолчанию: последний)
#   LANGS="ru"          языки перевода через пробел; LANGS="" -- без перевода
#   WITH_LUCI=0         только бинарник и сервис, без веб-интерфейса
#   REPO=владелец/реп   откуда брать релизы
#   PKG_ARCH=<арх>      принудительно указать архитектуру пакетов (см. opkg print-architecture)
# Пример:  curl -fsSL <URL> | TAG=v1.30.0-2 WITH_LUCI=0 sh
set -u

REPO="${REPO:-PaWill68/openwrt-opera-proxy}"
TAG="${TAG:-latest}"
LANGS="${LANGS-ru}"
WITH_LUCI="${WITH_LUCI:-1}"
WORKDIR=/tmp/opera-proxy-install

say()  { printf '%s\n' "$*"; }
warn() { printf 'Внимание: %s\n' "$*" >&2; }
die()  { printf 'Ошибка: %s\n' "$*" >&2; rm -rf "$WORKDIR"; exit 1; }

command -v curl >/dev/null 2>&1 || die "нужен curl (установите его: opkg update && opkg install curl или apk add curl)"

# fetch URL [ФАЙЛ] -- без ФАЙЛА пишет в stdout
fetch() {
    url="$1"
    out="${2:-}"
    if [ -n "$out" ]; then
        curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 -o "$out" "$url"
    else
        curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 -H "Accept: application/vnd.github+json" "$url"
    fi
}

# Базовая проверка заголовков/сигнатуры, когда нет SHA256SUMS или sha256sum
check_package_format() {
    f="$1"
    name="${f##*/}"

    if [ "$EXT" = ipk ]; then
        b1=$(dd if="$f" bs=1 count=1 2>/dev/null | od -An -tu1 2>/dev/null | tr -d ' \n')
        b2=$(dd if="$f" bs=1 skip=1 count=1 2>/dev/null | od -An -tu1 2>/dev/null | tr -d ' \n')
        if [ -n "${b1:-}" ] && [ -n "${b2:-}" ]; then
            if [ "$b1" != "31" ] || [ "$b2" != "139" ]; then
                warn "неверная сигнатура ipk-архива $name (байты: $b1 $b2, ожидалось 31 139)"
                return 1
            fi
        fi
    elif [ "$EXT" = apk ]; then
        magic3=$(head -c 3 "$f" 2>/dev/null)
        if [ "$magic3" != "ADB" ]; then
            warn "неверная сигнатура apk-файла $name (ожидалось 'ADB', получено: '$magic3')"
            return 1
        fi
    fi

    return 0
}

# Проверка пакета: сначала по SHA256SUMS, при отсутствии файла/утилиты -- по формату
verify_package() {
    f="$1"
    name="${f##*/}"

    [ -s "$f" ] || { warn "файл пустой: $name"; return 1; }

    head_txt=$(head -c 128 "$f" 2>/dev/null | tr '[:upper:]' '[:lower:]')
    case "$head_txt" in
        *"<!doctype html"*|*"<html"*|*"<?xml"*)
            warn "файл содержит HTML/XML вместо пакета: $name"
            return 1
            ;;
    esac

    if [ "$HAS_SHA" = 1 ]; then
        expected=$(awk -v target="$name" '
            {
                file = $2
                sub(/^\.\//, "", file)
                sub(/^\*/, "", file)
                if (file == target) {
                    print tolower($1)
                    exit
                }
            }
        ' "$SHA_FILE")

        if [ -n "${expected:-}" ]; then
            actual=$(sha256sum "$f" 2>/dev/null | awk '{ print tolower($1) }')
            if [ -z "${actual:-}" ]; then
                warn "не удалось вычислить SHA-256 для $name"
                return 1
            fi
            if [ "$actual" != "$expected" ]; then
                warn "несовпадение SHA-256 для $name (ожидалось: $expected, получено: $actual)"
                return 1
            fi
            return 0
        fi
        warn "хеш для $name не найден в SHA256SUMS -- проверяю формат файла"
    fi

    check_package_format "$f"
}

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

SHA_URL=$(printf '%s\n' "$JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https:[^"]*\)"$/\1/' | grep '/SHA256SUMS$' | head -n 1)
if [ -z "$SHA_URL" ]; then
    if [ "$TAG" = latest ]; then
        SHA_URL="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
    else
        SHA_URL="https://github.com/$REPO/releases/download/$TAG/SHA256SUMS"
    fi
fi

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

# --- загрузка и проверка ------------------------------------------------------------
rm -rf "$WORKDIR"; mkdir -p "$WORKDIR" || die "не удалось создать $WORKDIR"

SHA_FILE="$WORKDIR/SHA256SUMS"
HAS_SHA=0
if fetch "$SHA_URL" "$SHA_FILE" >/dev/null 2>&1 && [ -s "$SHA_FILE" ] && command -v sha256sum >/dev/null 2>&1; then
    HAS_SHA=1
    say "Контрольные суммы: загружен SHA256SUMS"
else
    warn "SHA256SUMS недоступен или нет sha256sum -- будет выполнена базовая проверка формата пакетов"
fi

FILES=""
for u in $LIST; do
    f="$WORKDIR/${u##*/}"
    say "Загрузка: ${u##*/}"
    fetch "$u" "$f" || die "не удалось скачать $u"
    verify_package "$f" || die "скачан повреждённый или некорректный файл пакета: ${u##*/}"
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
