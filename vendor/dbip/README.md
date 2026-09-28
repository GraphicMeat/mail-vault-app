`dbip-country-lite.mmdb` is DB-IP's "IP to Country Lite" database, September
2026 edition (https://download.db-ip.com/free/dbip-country-lite-2026-09.mmdb.gz),
by DB-IP (https://db-ip.com), licensed under the Creative Commons Attribution
4.0 International License (https://creativecommons.org/licenses/by/4.0/).

The daemon compiles it in (`src-core/src/geo_ip.rs`) to place Network
Activity's connections on the map, offline. The attribution the licence asks
for is shown on that page ("IP geolocation by DB-IP").

To refresh: download the current month's `.mmdb.gz` from
https://db-ip.com/db/download/ip-to-country-lite, unpack it over this file.
