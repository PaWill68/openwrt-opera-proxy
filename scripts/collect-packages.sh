#!/usr/bin/env bash
# Собирает пакеты после SDK в одну папку с однозначными именами.
#   collect-packages.sh <каталог SDK bin/packages/<arch>/<feed>> <arch> <куда складывать>
#
# .ipk уже содержит архитектуру в имени. У .apk имя вида  opera-proxy-1.30.0-r1.apk  --
# архитектуры в нём нет, и файлы разных архитектур в одном релизе затирали бы друг друга,
# поэтому добавляем суффикс: _<arch> для бинарного пакета и _all для luci-*.
set -euo pipefail
src="$1"; arch="$2"; out="$3"
mkdir -p "$out"
shopt -s nullglob

n=0
for f in "$src"/*.ipk "$src"/*.apk; do
    b=$(basename "$f"); ext="${b##*.}"; stem="${b%.*}"
    if [ "$ext" = apk ]; then
        case "$stem" in luci-*) suffix=all ;; *) suffix="$arch" ;; esac
        b="${stem}_${suffix}.apk"
    fi
    cp "$f" "$out/$b"
    echo "  $b  ($(stat -c%s "$out/$b") байт)"
    n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "::error::в $src нет ни одного пакета"; exit 1; }

# Должны быть все три пакета (3-й -- русский перевод, его luci.mk делает из po/ru).
for want in opera-proxy luci-app-opera-proxy luci-i18n-opera-proxy-ru; do
    compgen -G "$out/${want}[_-][0-9]*" >/dev/null \
        || { echo "::error::пакет '$want' не собран для $arch"; exit 1; }
done
