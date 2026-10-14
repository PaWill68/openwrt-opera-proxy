# SPDX-License-Identifier: MIT
#
# Пакет opera-proxy: готовый бинарник + init-скрипт + UCI-конфиг.
#
# Бинарник сюда не компилируется: его собирает CI (Go, кросс-компиляция под нужную
# архитектуру, опционально UPX) и кладёт в opera-proxy/bin/opera-proxy перед запуском
# SDK. SDK только упаковывает его в .ipk (OpenWrt 24.10) или .apk (OpenWrt 25.12).
# PKG_VERSION и PKG_RELEASE перезаписываются CI (см. .github/workflows/build.yml).

include $(TOPDIR)/rules.mk

PKG_NAME:=opera-proxy
PKG_VERSION:=1.30.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/opera-proxy
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Opera VPN (SurfEasy) HTTP/SOCKS5 proxy client with procd init script
  URL:=https://github.com/Alexey71/opera-proxy
  DEPENDS:=+ca-bundle
endef

define Package/opera-proxy/description
  opera-proxy is a local HTTP or SOCKS5 proxy that tunnels traffic through the
  Opera VPN (SurfEasy) infrastructure.
  This package contains the prebuilt opera-proxy binary, the procd init script
  (/etc/init.d/opera-proxy) and the UCI configuration (/etc/config/opera-proxy).
  The web interface is provided by the luci-app-opera-proxy package.
endef

define Package/opera-proxy/conffiles
/etc/config/opera-proxy
endef

# Исходников нет: проверяем, что CI положил бинарник, и копируем его в каталог сборки.
define Build/Prepare
	test -x ./bin/opera-proxy || { echo "ERROR: opera-proxy/bin/opera-proxy is missing (CI must put the prebuilt binary there)"; exit 1; }
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./bin/opera-proxy $(PKG_BUILD_DIR)/opera-proxy
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/opera-proxy/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/opera-proxy $(1)/usr/bin/opera-proxy
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/opera-proxy.init $(1)/etc/init.d/opera-proxy
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/opera-proxy.config $(1)/etc/config/opera-proxy
endef

$(eval $(call BuildPackage,opera-proxy))
